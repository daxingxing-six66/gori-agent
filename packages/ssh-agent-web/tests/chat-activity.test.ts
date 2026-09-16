import { describe, expect, it } from "vitest";
import { waitingForChatResponse } from "../features/chat/model/chat-activity";
import { initialChatRuntimeState, type ChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import type { AssistantMessage } from "../features/chat/model/chat";

const state: ChatRuntimeState = { ...initialChatRuntimeState, run: { id: "run", sessionId: "s", workspaceId: "w", requestId: "r", providerId: "p", modelId: "m", thinkingLevel: "off", serverInteractionMode: "command", terminalSessionId: null, status: "running", createdAt: 0, updatedAt: 0 } };
const assistant: AssistantMessage = { role: "assistant", content: [], provider: "p", model: "m", stopReason: "stop", timestamp: 1 };

describe("waiting for first model content", () => {
	it("stops waiting for pending approvals and for a finished run", () => {
		expect(waitingForChatResponse({ ...state, approvals: { approval: {
			id: "approval", sessionId: "s", runId: "run", assistantMessageId: "a", toolCallId: "t",
			toolName: "bash", description: "approval", status: "pending", createdAt: 0,
		} } }, false, false)).toBe(false);
		if (!state.run) throw new Error("Missing run fixture");
		expect(waitingForChatResponse({ ...state, run: { ...state.run, status: "completed" } }, false, false)).toBe(false);
	});
	it("hides for redacted thinking without exposing its contents", () => {
		expect(waitingForChatResponse({ ...state, timeline: [{ key: "redacted", runId: "run", final: false,
			message: { ...assistant, content: [{ type: "thinking", thinking: "", redacted: true }] },
		}] }, false, false)).toBe(false);
	});
	it("waits during submission and active runs but not idle or loading", () => {
		expect(waitingForChatResponse(initialChatRuntimeState, false, true)).toBe(true);
		expect(waitingForChatResponse(initialChatRuntimeState, false, false)).toBe(false);
		expect(waitingForChatResponse(state, true, true)).toBe(false);
		expect(waitingForChatResponse(state, false, false)).toBe(true);
	});
	it("ignores old runs and empty starts, hides on text thinking or tool content", () => {
		for (const content of [[{ type: "text", text: "hello" }], [{ type: "thinking", thinking: "thinking" }], [{ type: "toolCall", id: "t", name: "bash", arguments: {} }]] satisfies AssistantMessage["content"][]) {
			const entry = { key: "a", runId: "run", message: { ...assistant, content }, final: false };
			expect(waitingForChatResponse({ ...state, timeline: [entry] }, false, true)).toBe(false);
			expect(waitingForChatResponse({ ...state, timeline: [{ ...entry, runId: "old" }] }, false, false)).toBe(true);
		}
		expect(waitingForChatResponse({ ...state, timeline: [{ key: "empty", runId: "run", message: assistant, final: false }] }, false, false)).toBe(true);
	});
});
