import { convertToLlm } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { stream as completions } from "../../ai/src/api/openai-completions.ts";
import { stream as mistral } from "../../ai/src/api/mistral-conversations.ts";
import { convertResponsesMessages } from "../../ai/src/api/openai-responses-shared.ts";
import { transformMessages } from "../../ai/src/api/transform-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

const context: Context = {
	systemPrompt: "fixed head",
	messages: [
		{ role: "system", content: [{ type: "text", text: "<terminal-model-off>" }], timestamp: 1 },
		{ role: "user", content: "hello", timestamp: 2 },
		fauxAssistantMessage("hello", { timestamp: 3 }),
		{ role: "system", content: [{ type: "text", text: "<terminal-model-on>" }], timestamp: 4 },
		{ role: "user", content: "continue", timestamp: 5 },
	],
};
const model = fauxProvider().getModel();

describe("chronological system message adapters", () => {
	it("preserves roles when projecting Agent messages to LLM history", () => {
		expect(convertToLlm(context.messages)).toEqual(context.messages);
	});
	it("preserves Responses system roles and their positions", () => {
		const payload = convertResponsesMessages({ ...model, api: "openai-responses" }, context, new Set());
		expect(payload.map((message) => "role" in message ? message.role : message.type))
			.toEqual(["system", "system", "user", "assistant", "system", "user"]);
		expect(payload[4]).toMatchObject({ role: "system", content: [{ type: "input_text", text: "<terminal-model-on>" }] });
	});
	it.each(["openai-completions", "mistral-conversations"] as const)("preserves native roles in %s payload without network", async (api) => {
		let payload: unknown;
		const options = { apiKey: "local-test-only", onPayload(value: unknown) { payload = value; throw new Error("stop before network"); } };
		const response = api === "openai-completions"
			? completions({ ...model, api }, context, options)
			: mistral({ ...model, api }, context, options);
		await response.result();
		expect(payload).toMatchObject({ messages: [
			{ role: "system", content: "fixed head" },
			{ role: "system", content: "<terminal-model-off>" },
			{ role: "user" }, { role: "assistant" },
			{ role: "system", content: "<terminal-model-on>" }, { role: "user" },
		] });
	});
	it("rejects unsupported APIs instead of hoisting or demoting a system message", () => {
		expect(() => transformMessages(context.messages, { ...model, api: "anthropic-messages" })).toThrow("chronological system");
	});
	it.each(["openai-completions", "openai-responses", "mistral-conversations"] as const)("pairs a persisted tool result before a Terminal mode event in %s", async (api) => {
		const call = { ...fauxAssistantMessage("", { timestamp: 10 }), stopReason: "toolUse" as const,
			content: [{ type: "toolCall" as const, id: "interrupted-call", name: "terminal_interaction", arguments: { action: "key", key: "CTRL_C" } }] };
		const modeEvent = { role: "system" as const, content: [{ type: "text" as const, text: "<terminal-model-off>" }], timestamp: 11 };
		const result: ToolResultMessage = { role: "toolResult", toolCallId: "interrupted-call", toolName: "terminal_interaction", content: [{ type: "text", text: "actual result" }], isError: false, timestamp: 12 };
		const input: Context = { messages: [call, modeEvent, result, { role: "user", content: "continue", timestamp: 13 }] };
		const original = JSON.stringify(input);
		if (api === "openai-responses") {
			const payload = convertResponsesMessages({ ...model, api }, input, new Set());
			expect(payload.map((message) => "role" in message ? message.role : message.type))
				.toEqual(["function_call", "function_call_output", "system", "user"]);
			expect(payload[1]).toMatchObject({ type: "function_call_output", output: "actual result" });
		} else {
			let payload: unknown;
			const options = { apiKey: "local-test-only", onPayload(value: unknown) { payload = value; throw new Error("stop before network"); } };
			await (api === "openai-completions" ? completions({ ...model, api }, input, options) : mistral({ ...model, api }, input, options)).result();
			expect(payload).toMatchObject({ messages: api === "openai-completions" ? [
				{ role: "assistant", tool_calls: [{ id: "interrupted-call" }] },
				{ role: "tool", tool_call_id: "interrupted-call", content: "actual result" },
				{ role: "system", content: "<terminal-model-off>" }, { role: "user" },
			] : [
				{ role: "assistant", toolCalls: [{ id: expect.any(String) }] },
				{ role: "tool", toolCallId: expect.any(String), content: [{ type: "text", text: "actual result" }] },
				{ role: "system", content: "<terminal-model-off>" }, { role: "user" },
			] });
		}
		expect(JSON.stringify(input)).toBe(original);
	});
});
