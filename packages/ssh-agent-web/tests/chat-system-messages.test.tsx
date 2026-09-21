import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { isAgentMessage, type ChatMessage } from "../features/chat/model/chat";
import { chatRuntimeReducer, initialChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import { enUSMessages } from "../features/i18n/messages/en-US";

const messages: ChatMessage[] = ["on", "off", "on"].map((mode, index) => ({
	id: `mode-${index}`, sequence: index + 1, createdAt: 100,
	message: { role: "system", runtimeEventId: `mode-${index}`, timestamp: 100,
		content: [{ type: "text", text: `<terminal-model-${mode}>` }] },
}));

describe("runtime system messages", () => {
	it("accepts text-only system messages and preserves distinct transitions at the same timestamp", () => {
		expect(isAgentMessage(messages[0]!.message)).toBe(true);
		expect(isAgentMessage({ role: "system", content: [{ type: "image", data: "bad" }], timestamp: 1 })).toBe(false);
		const state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages });
		expect(state.timeline).toHaveLength(3);
		expect(chatRuntimeReducer(state, { type: "mergePersisted", messages }).timeline).toEqual(state.timeline);
		expect(state.maxSequence).toBe(3);
	});
	it("does not render mode protocol as assistant messages or suppress the empty conversation", () => {
		const state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages });
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "en-US", messages: enUSMessages },
			createElement(ChatTimeline, { showActivity: false, loading: false, loadingOlderMessages: false,
				timeline: state.timeline, tools: {}, approvals: {}, approvalMutationId: null, run: null,
				latestUserText: "", onResolveApproval: () => {}, onRestoreDraft: () => {} })));
		expect(html).not.toContain("terminal-model");
		expect(html).toContain(enUSMessages["chat.empty.title"]);
	});
});
