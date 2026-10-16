import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatMessageRow } from "../features/chat/components/chat-message";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { isAgentMessage, type AgentMessage, type ChatMessage } from "../features/chat/model/chat";
import { chatRuntimeReducer, initialChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import { parseChatStreamEvent } from "../features/chat/runtime/chat-event-stream";
import { enUSMessages } from "../features/i18n/messages/en-US";

const deployment = (id: string, sequence: number): ChatMessage => ({
	id: `deployment:${id}`, sequence, createdAt: 100,
	message: { role: "custom", customType: "deployment", content: "API", display: true,
		details: { deploymentId: id, title: "API" }, timestamp: 100 },
});

describe("structured Chat history", () => {
	it("accepts custom text and block content through the same SSE message boundary", () => {
		const message = deployment("release", 1).message;
		expect(isAgentMessage(message)).toBe(true);
		expect(isAgentMessage({ ...message, content: [{ type: "text", text: "metadata" }] })).toBe(true);
		expect(isAgentMessage({ ...message, content: 42 })).toBe(false);
		expect(isAgentMessage({ ...message, display: "true" })).toBe(false);
		expect(isAgentMessage({ ...message, customType: null })).toBe(false);
		expect(parseChatStreamEvent("message_end", { message })).toEqual({
			type: "message_end", data: { type: "message_end", message },
		});
	});

	it("preserves distinct deployments at the same timestamp and deduplicates a REST merge", () => {
		const messages = [deployment("release-a", 114), deployment("release-b", 115)];
		const state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages });
		expect(state.timeline).toHaveLength(2);
		expect(state.maxSequence).toBe(115);
		expect(chatRuntimeReducer(state, { type: "mergePersisted", messages }).timeline).toEqual(state.timeline);
	});

	it("renders a persisted deployment message alongside normal conversation without treating its string as Assistant blocks", () => {
		const messages: ChatMessage[] = [
			deployment("release", 114),
			{ id: "user", sequence: 115, createdAt: 101, message: { role: "user", content: "Inspect the release", timestamp: 101 } },
			{ id: "assistant", sequence: 116, createdAt: 102, message: { role: "assistant", provider: "test", model: "test",
				content: [{ type: "text", text: "The conversation is available." }], stopReason: "stop", timestamp: 102 } },
		];
		const state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages });
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "en-US", messages: enUSMessages },
			createElement(ChatTimeline, { showActivity: false, loading: false, loadingOlderMessages: false,
				timeline: state.timeline, tools: {}, approvals: {}, approvalMutationId: null, run: null,
				latestUserText: "", onResolveApproval: () => {}, onRestoreDraft: () => {} })));
		expect(html).toContain("Inspect the release");
		expect(html).toContain("The conversation is available.");
		expect(html.match(/chat-assistant-message/gu)).toHaveLength(1);
		expect(state.timeline[0]?.message).toEqual(messages[0]?.message);
	});

	it("retains the backend placement when pages merge in the opposite order", () => {
		const card = { ...deployment("legacy", 2), historyOrder: 1 as const };
		const anchor: ChatMessage = { id: "anchor", sequence: 2, createdAt: 90, message: { role: "user", content: "Anchor", timestamp: 90 } };
		const later: ChatMessage = { id: "later", sequence: 3, createdAt: 110, message: { role: "user", content: "Later", timestamp: 110 } };
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages: [card, later] });
		state = chatRuntimeReducer(state, { type: "mergePersisted", messages: [anchor, card] });
		expect(state.timeline.map((entry) => entry.key)).toEqual(["persisted:anchor", "persisted:deployment:legacy", "persisted:later"]);
		expect(state.maxSequence).toBe(3);
	});

	it.each([
		{ role: "future-task", content: "metadata", timestamp: 1 },
		{ role: "assistant", content: "invalid wire content", timestamp: 1 },
	])("does not enter the Assistant renderer for unsupported wire shape %j", (message) => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "en-US", messages: enUSMessages },
			createElement(ChatMessageRow, { entry: { key: "wire", final: true, message: message as unknown as AgentMessage },
				tools: {}, approvals: {}, approvalMutationId: null, onResolveApproval: () => {} })));
		expect(html).toBe("");
	});
});
