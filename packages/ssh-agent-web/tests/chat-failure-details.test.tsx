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

	it.each(["stream", "finished", "history"])("treats an aborted response as cancellation in %s while retaining partial output", (source) => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(ChatTimeline, {
			showActivity: false, loading: false, loadingOlderMessages: false,
			timeline: [{ key: "cancelled-message", runId: "run", final: source !== "stream", message: {
				role: "assistant", provider: "provider", model: "model", timestamp: 2, stopReason: "aborted", errorMessage: "Request was aborted",
				content: [{ type: "thinking", thinking: "取消前的思考" }, { type: "text", text: "取消前已经输出的内容" }],
			} }],
			tools: {}, approvals: {}, approvalMutationId: null,
			run: source === "history" ? null : { ...run, status: source === "stream" ? "running" : "cancelled", failure: undefined },
			latestUserText: "hello", onResolveApproval: () => undefined, onRestoreDraft: () => undefined,
		})));
		expect(html).toContain("取消前已经输出的内容");
		expect(html).toContain("取消前的思考");
		expect(html).not.toContain("Request was aborted");
		expect(html).not.toContain("danger-line");
		expect(html).not.toContain("本次运行失败");
	});

	it("does not show an error when cancellation happens before any output", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(ChatTimeline, {
			showActivity: false, loading: false, loadingOlderMessages: false,
			timeline: [{ key: "cancelled-message", runId: "run", final: true, message: {
				role: "assistant", provider: "provider", model: "model", timestamp: 2,
				stopReason: "aborted", errorMessage: "用户取消请求", content: [],
			} }],
			tools: {}, approvals: {}, approvalMutationId: null, run: null,
			latestUserText: "hello", onResolveApproval: () => undefined, onRestoreDraft: () => undefined,
		})));
		expect(html).not.toContain("用户取消请求");
		expect(html).not.toContain("danger-line");
	});

	it("keeps a real failure visible even if its text mentions abort and the Run is later cancelled", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(ChatTimeline, {
			showActivity: false, loading: false, loadingOlderMessages: false,
			timeline: [{ key: "failed-message", runId: "run", final: true, message: {
				role: "assistant", provider: "provider", model: "model", timestamp: 2,
				stopReason: "error", errorMessage: "Upstream aborted the connection", content: [],
			} }],
			tools: {}, approvals: {}, approvalMutationId: null, run: { ...run, status: "cancelled", failure: undefined },
			latestUserText: "hello", onResolveApproval: () => undefined, onRestoreDraft: () => undefined,
		})));
		expect(html).toContain("Upstream aborted the connection");
		expect(html).toContain("danger-line");
	});
});
