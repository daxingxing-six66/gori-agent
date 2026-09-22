import { resolve } from "node:path";
import { Agent, type AgentTool, type AgentToolCall } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { configureFileToolConcurrency, fileToolBatchRequiresSequence } from "../src/application/services/file-tool-concurrency.ts";

const cwd = resolve("/work");
const env = new NodeExecutionEnv({ cwd });
const read = (path: string) => fauxToolCall("read", { path });
const upload = (sourceFilePath: string, targetPath = "/remote") => fauxToolCall("sftp_upload", { sourceFilePath, targetPath });
const download = (remoteFilePath: string, targetPath = "downloads") => fauxToolCall("sftp_download", { remoteFilePath, targetPath });

describe("file tool path scheduling", () => {
	it.each([
		["read/read", [read("a"), read("./a")], false],
		["read/upload source", [read("a"), upload("a")], false],
		["independent transfers", [upload("a"), upload("b"), download("/remote/c")], false],
		["same download source, different targets", [download("/remote/a", "one"), download("/remote/a", "two")], false],
		["separate namespaces", [read("/remote/a"), upload("a")], false],
		["same upload basename", [upload("one/a"), upload("two/a")], true],
		["same local destination", [download("/one/a"), download("/two/a")], true],
		["remote read/write", [upload("a"), download("/remote/a")], true],
		["local read/write", [download("/remote/a", "."), read("a")], true],
		["download/upload dependency", [download("/remote/a", "."), upload("a", "/other")], true],
		["normalized remote paths", [upload("a", "/remote/dir/.."), download("/remote/a")], true],
		["normalized local paths", [read("./nested/../a"), download("/remote/a", cwd)], true],
		["overlapping directories", [download("/remote/a", "."), upload("a/child")], true],
		["path component boundaries", [download("/remote/a", "."), upload("abc")], false],
		["read spelling fallback", [read("@a"), upload("b")], true],
		["unknown tool", [read("a"), fauxToolCall("plugin", {})], true],
		["invalid arguments", [upload("a"), fauxToolCall("sftp_download", { remoteFilePath: 1 })], true],
		["relative remote path", [upload("a", "remote"), read("b")], true],
	] as const)("%s", async (_label, calls, sequential) => {
		expect(await fileToolBatchRequiresSequence(calls, env)).toBe(sequential);
	});

	it("falls back to serial on path resolution failure or cancellation", async () => {
		expect(await fileToolBatchRequiresSequence([read("a")], { absolutePath: async () => { throw new Error("unavailable"); } })).toBe(true);
		expect(await fileToolBatchRequiresSequence([read("a")], env, AbortSignal.abort())).toBe(true);
	});
});

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

function fixture(calls: AgentToolCall[], customize?: (tools: AgentTool[]) => AgentTool[]) {
	const started: string[] = [];
	const ended: string[] = [];
	const results: string[] = [];
	const gates = calls.map(() => deferred());
	const tools: AgentTool[] = [...new Set(calls.map((call) => call.name))].map((name) => ({
		name, label: name, description: name, parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (id, _args, signal) => {
			started.push(id);
			await gates[calls.findIndex((call) => call.id === id)]!.promise;
			if (signal?.aborted) throw new Error("cancelled");
			return { content: [{ type: "text", text: id }], details: {} };
		},
	}));
	const provider = fauxProvider();
	const models = createModels(); models.setProvider(provider.provider);
	provider.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const configured = configureFileToolConcurrency(tools, env);
	const agent = new Agent({
		initialState: { model: provider.getModel(), tools: customize ? customize(configured) : configured },
		streamFn: (model, context, options) => models.streamSimple(model, context, options),
	});
	agent.subscribe((event) => {
		if (event.type === "tool_execution_end") ended.push(event.toolCallId);
		if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message.toolCallId);
	});
	return { agent, gates, started, ended, results };
}

describe("real Agent batch scheduling", () => {
	it("overlaps independent calls, emits completion as ready and returns results in source order", async () => {
		const calls = [upload("a"), download("/remote/b"), read("c")];
		const test = fixture(calls);
		const run = test.agent.prompt("transfer");
		try {
			await vi.waitFor(() => expect(test.started).toEqual(calls.map((call) => call.id)));
			for (const i of [2, 1, 0]) {
				test.gates[i]!.release();
				await vi.waitFor(() => expect(test.ended).toContain(calls[i]!.id));
			}
			await run;
			expect(test.ended).toEqual([...calls].reverse().map((call) => call.id));
			expect(test.results).toEqual(calls.map((call) => call.id));
		} finally { test.gates.forEach((gate) => gate.release()); await run; }
	});

	it.each(["conflict", "write", "bash", "remote_server_call", "terminal_interaction", "restriction failure", "static override"])(
		"keeps the entire batch serial with %s", async (reason) => {
			const calls = [upload("a"), reason === "conflict" ? download("/remote/a")
				: reason === "restriction failure" || reason === "static override" ? read("b") : fauxToolCall(reason, {}), upload("c")];
			const test = fixture(calls, (tools) => tools.map((tool) => reason === "restriction failure"
				? { ...tool, requiresSequentialExecution: () => { throw new Error("check failed"); } }
				: reason === "static override" && tool.name === "read" ? { ...tool, executionMode: "sequential" } : tool));
			const run = test.agent.prompt("transfer");
			try {
				for (let i = 0; i < calls.length; i++) {
					await vi.waitFor(() => expect(test.started).toEqual(calls.slice(0, i + 1).map((call) => call.id)));
					expect(test.ended).toEqual(calls.slice(0, i).map((call) => call.id));
					test.gates[i]!.release();
				}
				await run;
				expect(test.results).toEqual(calls.map((call) => call.id));
			} finally { test.gates.forEach((gate) => gate.release()); await run; }
		},
	);

	it("evaluates a shared restriction once and never bypasses global sequential mode", async () => {
		const calls = [read("a"), upload("b")];
		const restriction = vi.fn(() => false);
		const test = fixture(calls, (tools) => tools.map((tool) => ({ ...tool, requiresSequentialExecution: restriction })));
		test.agent.toolExecution = "sequential";
		test.gates.forEach((gate) => gate.release());
		await test.agent.prompt("go");
		expect(restriction).not.toHaveBeenCalled();
		test.agent.toolExecution = "parallel";
		// A fresh fixture produces another tool batch, with the same callback on both tools.
		const parallel = fixture(calls, (tools) => tools.map((tool) => ({ ...tool, requiresSequentialExecution: restriction })));
		parallel.gates.forEach((gate) => gate.release());
		await parallel.agent.prompt("go");
		expect(restriction).toHaveBeenCalledOnce();
	});
});
