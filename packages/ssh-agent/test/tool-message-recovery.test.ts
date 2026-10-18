import { fauxAssistantMessage, fauxProvider, type AssistantMessage, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { transformMessages } from "../../ai/src/api/transform-messages.ts";

const model = fauxProvider().getModel();
function calls(...ids: string[]): AssistantMessage {
	return { ...fauxAssistantMessage("", { timestamp: 10 }), stopReason: "toolUse",
		content: ids.map((id) => ({ type: "toolCall", id, name: "terminal_interaction", arguments: { action: "key", key: "CTRL_C" } })) };
}
function output(id: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "terminal_interaction", content: [{ type: "text", text: `actual output ${id}` }], isError: false, timestamp: 20 };
}
function system(text = "<terminal-model-off>"): Message {
	return { role: "system", content: [{ type: "text", text }], timestamp: 15 };
}
const user: Message = { role: "user", content: "continue", timestamp: 30 };

function expectPaired(messages: Message[]) {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			expect(pending.delete(message.toolCallId), `unexpected result: ${message.toolCallId}`).toBe(true);
		} else {
			expect([...pending], `incomplete tool group before ${message.role}`).toEqual([]);
			if (message.role === "assistant") {
				for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
			}
		}
	}
	expect([...pending]).toEqual([]);
}

describe("tool message recovery without executing or rewriting history", () => {
	it("preserves the real result when Terminal mode changes between call and result", () => {
		const history = [calls("ctrl-c"), system(), output("ctrl-c"), user];
		const original = JSON.stringify(history);
		const result = transformMessages(history, model);
		expect(result).toEqual([history[0], history[2], history[1], user]);
		expect(result.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expectPaired(result);
		expect(JSON.stringify(history)).toBe(original);
	});

	it("keeps parallel results together and preserves all deferred system messages in order", () => {
		const history = [calls("a", "b"), system("first"), output("b"), system("second"), output("a"), system("third"), user];
		const result = transformMessages(history, model);
		expect(result).toEqual([history[0], history[2], history[4], history[1], history[3], history[5], user]);
		expectPaired(result);
	});

	it.each(["user", "assistant", "end"])("closes a genuinely interrupted group before %s with an explicit unknown outcome", (boundary) => {
		const next = boundary === "user" ? [user] : boundary === "assistant" ? [fauxAssistantMessage("run interrupted")] : [];
		const history = [calls("done", "missing"), output("done"), system(), ...next];
		const result = transformMessages(history, model);
		const outputs = result.filter((message) => message.role === "toolResult");
		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toEqual(output("done"));
		expect(outputs[1]).toMatchObject({ toolCallId: "missing", toolName: "terminal_interaction", isError: true, timestamp: 10 });
		expect(outputs[1]?.content).toEqual([{ type: "text", text: expect.stringMatching(/may have taken effect.*check.*retry/i) }]);
		expectPaired(result);
		expect(transformMessages(result, model)).toEqual(result);
	});

	it("omits unmatched and duplicate results only from the provider projection", () => {
		const history = [output("orphan"), calls("a"), output("unrelated"), output("a"), output("a"), user];
		const original = JSON.stringify(history);
		const result = transformMessages(history, model);
		expect(result).toEqual([history[1], history[3], user]);
		expectPaired(result);
		expect(JSON.stringify(history)).toBe(original);
	});

	it.each(["error", "aborted"] as const)("does not replay incomplete %s assistant content or leave its orphan result", (stopReason) => {
		const result = transformMessages([{ ...calls("partial"), stopReason }, output("partial"), user], model);
		expect(result).toEqual([user]);
		expectPaired(result);
	});

	it("normalizes cross-model IDs consistently while regrouping results", () => {
		const parent = { ...calls("call|foreign"), model: "other-model" };
		const result = transformMessages([parent, system(), output("call|foreign"), user], model, (id) => id.replaceAll("|", "_"));
		expect(result[0]).toMatchObject({ content: [{ type: "toolCall", id: "call_foreign" }] });
		expect(result[1]).toMatchObject({ role: "toolResult", toolCallId: "call_foreign", isError: false });
		expectPaired(result);
	});

	it("keeps completed tool groups and chronological system messages unchanged", () => {
		const history = [system("before"), calls("a"), output("a"), system("after"), user];
		expect(transformMessages(history, model)).toEqual(history);
	});
});
