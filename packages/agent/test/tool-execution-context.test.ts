import { type AssistantMessage, EventStream, type AssistantMessageEvent, type Message, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentTool, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock", name: "mock", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192, maxTokens: 2048,
};

function response(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function fixture(hook: AgentLoopConfig["beforeToolCall"], mode: "sequential" | "parallel", signal?: AbortSignal) {
	const schema = Type.Object({ value: Type.String() });
	const execute = vi.fn<AgentTool<typeof schema>["execute"]>(async () => ({ content: [{ type: "text", text: "done" }], details: {} }));
	const tool: AgentTool<typeof schema> = { name: "test", label: "test", description: "test", parameters: schema, execute };
	const events: AgentEvent[] = [];
	const providerContexts: string[] = [];
	let request = 0;
	const streamFn: StreamFn = (_model, context) => {
		providerContexts.push(JSON.stringify(context));
		const message = response(request++ === 0
			? ["a", "b", "plain"].map((id) => ({ type: "toolCall", id, name: "test", arguments: { value: id } })) : []);
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done", (event) => event.type === "done" ? event.message : message,
		);
		queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); });
		return stream;
	};
	const run = () => runAgentLoop([{ role: "user", content: "test", timestamp: 1 }],
		{ systemPrompt: "test", messages: [], tools: [tool] },
		{ model, convertToLlm: (messages) => messages as Message[],
			beforeToolCall: hook, toolExecution: mode }, (event) => { events.push(event); }, signal, streamFn);
	return { execute, events, providerContexts, run };
}

describe("per-call tool execution context", () => {
	it.each(["sequential", "parallel"] as const)("hands off isolated contexts in %s mode without exposing them", async (mode) => {
		const contexts = { a: { secret: "approval-a" }, b: { secret: "approval-b" } };
		const f = fixture(async ({ toolCall }) => toolCall.id === "plain" ? undefined
			: { executionContext: contexts[toolCall.id as "a" | "b"] }, mode);
		const messages = await f.run();
		expect(f.execute.mock.calls.map((call) => call[4])).toEqual([contexts.a, contexts.b, undefined]);
		expect(f.execute.mock.calls[0][4]).toBe(contexts.a);
		expect(f.execute.mock.calls[1][4]).toBe(contexts.b);
		expect(f.execute.mock.calls[2]).toHaveLength(4);
		for (const serialized of [JSON.stringify(messages), JSON.stringify(f.events), ...f.providerContexts]) {
			expect(serialized).not.toContain("approval-a");
			expect(serialized).not.toContain("approval-b");
			expect(serialized).not.toContain("executionContext");
		}
	});

	it("does not execute a blocked call even when the hook returns an execution context", async () => {
		const f = fixture(async () => ({ block: true, terminate: true, executionContext: { secret: "blocked" } }), "parallel");
		const messages = await f.run();
		expect(f.execute).not.toHaveBeenCalled();
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
	});

	it("does not execute when cancellation arrives during authorization", async () => {
		const controller = new AbortController();
		const f = fixture(async () => { controller.abort(); return { executionContext: { secret: "cancelled" } }; },
			"sequential", controller.signal);
		await f.run();
		expect(f.execute).not.toHaveBeenCalled();
	});
});
