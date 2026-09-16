import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import type { ChatRun } from "../features/chat/model/chat";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const failure = { code: "chat_context_overflow", message: "原始失败原因", errorId: "error-root", retryable: false, recovery: { code: "chat_context_no_compactable_history", message: "没有历史可压缩", errorId: "error-recovery" } };
const run: ChatRun = { id: "run", sessionId: "session", workspaceId: "workspace", requestId: "request", providerId: "provider", modelId: "model", thinkingLevel: "off", serverInteractionMode: "command", terminalSessionId: null, status: "failed", failure, createdAt: 1, updatedAt: 2 };

describe("one failure presentation", () => {
	it.each([false, true])("retains partial output and recovery after history reload: %s", (reloaded) => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(ChatTimeline, {
			showActivity: false, loading: false, loadingOlderMessages: false,
			timeline: [{ key: "message", runId: "run", final: true, message: { role: "assistant", content: [{ type: "text", text: "已经输出的内容" }], provider: "provider", model: "model", stopReason: "error", timestamp: 2, errorMessage: failure.message, failure } }],
			tools: {}, approvals: {}, approvalMutationId: null, run: reloaded ? null : run, latestUserText: "hello", onResolveApproval: () => undefined, onRestoreDraft: () => undefined,
		})));
		expect(html).toContain("已经输出的内容");
		expect(html.match(/原始失败原因/g)).toHaveLength(1);
		expect(html.match(/没有历史可压缩/g)).toHaveLength(1);
		expect(html.match(/error-root/g)).toHaveLength(1);
	});
});
