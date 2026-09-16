import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { AgentRunError, type AgentTool } from "../src/types.ts";

function setup(tools: AgentTool[] = []) {
	const faux = fauxProvider({ provider: "failure-test", models: [{ id: "model" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const onRunFailure = vi.fn();
	const agent = new Agent({
		initialState: { model: faux.getModel(), tools },
		streamFn: (model, context, options) => models.streamSimple(model, context, options),
		onRunFailure,
	});
	return { agent, faux, onRunFailure };
}

describe("fatal run failures", () => {
	it("does not write a synthetic error into a failed persistence listener", async () => {
		const { agent, faux, onRunFailure } = setup();
		faux.setResponses([fauxAssistantMessage("done")]);
		const original = new Error("message persistence failed");
		const listener = vi.fn((event) => {
			if (event.type === "message_end") throw original;
		});
		agent.subscribe(listener);
		await expect(agent.prompt("hello")).rejects.toBe(original);
		expect(onRunFailure).toHaveBeenCalledExactlyOnceWith(original);
		expect(listener.mock.calls.filter(([event]) => event.type === "message_end")).toHaveLength(1);
		expect(faux.state.callCount).toBe(0);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("retains the root cause when the failure observer itself throws", async () => {
		const { agent } = setup();
		const original = new Error("root");
		const observer = new Error("observer");
		agent.beforeProviderRequest = () => {
			throw original;
		};
		agent.onRunFailure = () => {
			throw observer;
		};
		await expect(agent.prompt("hello")).rejects.toMatchObject({ cause: original, errors: [original, observer] });
		expect(agent.state.isStreaming).toBe(false);
	});

	it("aborts and waits for started siblings after a fatal tool failure", async () => {
		const fatal = new AgentRunError(undefined, "approval database failed");
		let siblingSettled = false;
		const tools: AgentTool[] = [
			{
				name: "fail",
				label: "fail",
				description: "fail",
				parameters: Type.Object({}),
				execute: async () => {
					throw fatal;
				},
			},
			{
				name: "wait",
				label: "wait",
				description: "wait",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal) => {
					await new Promise<void>((resolve) => {
						if (signal?.aborted) resolve();
						else signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					siblingSettled = true;
					return { content: [], details: {} };
				},
			},
		];
		const { agent, faux, onRunFailure } = setup(tools);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("fail", {}), fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		]);
		await agent.prompt("hello");
		expect(siblingSettled).toBe(true);
		expect(onRunFailure).toHaveBeenCalledExactlyOnceWith(fatal);
		expect(faux.state.callCount).toBe(1);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});
});
