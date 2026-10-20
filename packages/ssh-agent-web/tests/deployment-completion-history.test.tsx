import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { chatRuntimeReducer, initialChatRuntimeState, type ChatTimelineEntry } from "../features/chat/model/chat-runtime-state";
import type { ChatMessage, ChatToolExecution } from "../features/chat/model/chat";
import { conversationHistory, type ConversationHistoryEntry } from "../features/chat/model/conversation-history";
import { subscribeDeploymentEvents } from "../features/deploy/runtime/deployment-event-stream";
import { enUSMessages } from "../features/i18n/messages/en-US";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const start = { id: "deployment:release", sequence: 1, createdAt: 100,
	message: { role: "custom", customType: "deployment", content: "AI Web API", display: true, timestamp: 100,
		details: { deploymentId: "release", title: "AI Web API" } } } satisfies ChatMessage;
const user = (id: string, sequence: number, timestamp: number): ChatMessage => ({ id, sequence, createdAt: timestamp,
	message: { role: "user", content: id, timestamp } });
function finish(outcome: "success" | "failed" | "cancelled", position = "finished"): ChatMessage {
	return { ...start, sequence: 4, createdAt: 400, message: { ...start.message, timestamp: 400,
		details: { deploymentId: "release", title: "AI Web API", outcome, position, startedAt: 100, finishedAt: 400,
			...(outcome === "failed" ? { reason: "Health check returned HTTP 503" } : {}) } } };
}
const timeline = (messages: ChatMessage[]) => chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages }).timeline;
const ids = (entries: ConversationHistoryEntry[]) => entries.map((entry) => entry.kind === "message" ? entry.entry.key : entry.kind === "diagnoseMessage" ? entry.taskId : entry.kind === "deploymentMessage" ? entry.deploymentId : entry.kind === "discussion" ? entry.discussion.id : entry.run.id);
function render(messages: ChatMessage[], locale: "en-US" | "zh-CN" = "en-US", tools?: Record<string, ChatToolExecution>) {
	const state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages });
	return renderToStaticMarkup(createElement(IntlProvider, { locale, messages: locale === "en-US" ? enUSMessages : zhCNMessages },
		createElement(ChatTimeline, { timeline: state.timeline, showActivity: false, loading: false, loadingOlderMessages: false,
			tools: tools ?? state.tools, approvals: {}, approvalMutationId: null, run: null, latestUserText: "", onResolveApproval: vi.fn(), onRestoreDraft: vi.fn(), onOpenDeployment: vi.fn() })));
}

function finishCall(outcome: "success" | "failed"): ChatMessage {
	return { id: "finish-call", sequence: 3, createdAt: 300, message: { role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 300,
		content: [{ type: "text", text: "Before finish" }, { type: "toolCall", id: "finish", name: "deployment_finish", arguments: { outcome } },
			{ type: "text", text: "After finish" }, { type: "toolCall", id: "read", name: "read", arguments: { path: "/app/log" } }] } };
}
function finishResult(outcome: "success" | "failed" | "cancelled", overrides: { isError?: boolean; deploymentId?: string; text?: string } = {}): ChatMessage {
	return { id: "finish-result", sequence: 5, createdAt: 450, message: { role: "toolResult", toolCallId: "finish", toolName: "deployment_finish", timestamp: 450,
		isError: overrides.isError ?? false, content: [{ type: "text", text: overrides.text ?? JSON.stringify({ deploymentId: overrides.deploymentId ?? "release", outcome, deploymentMode: false }) }] } };
}

describe("deployment completion history", () => {
	it.each(["success", "failed"] as const)("substitutes a completed %s finish in place and preserves sibling content", (outcome) => {
		const messages = [finishCall(outcome), finish(outcome), finishResult(outcome)];
		const original = JSON.stringify(messages);
		const html = render(messages);
		expect(html.match(/data-deployment-id=/gu)).toHaveLength(1);
		expect(html).not.toContain("deployment_finish");
		expect(html.indexOf("Before finish")).toBeLessThan(html.indexOf('class="deployment-history-card"'));
		expect(html.indexOf('class="deployment-history-card"')).toBeLessThan(html.indexOf("After finish"));
		expect(html).toContain("/app/log");
		expect(html).toContain(`data-status="${outcome}"`);
		expect(JSON.stringify(messages)).toBe(original);
	});

	it("accepts the live result envelope and waits for the matching result card", () => {
		const call = finishCall("success");
		const tools: Record<string, ChatToolExecution> = { finish: { toolCallId: "finish", toolName: "deployment_finish", status: "completed",
			result: { content: [{ type: "text", text: JSON.stringify({ deploymentId: "release", outcome: "success", deploymentMode: false }) }] } } };
		expect(render([call], "en-US", tools)).toContain("deployment_finish");
		const html = render([call, finish("success")], "en-US", tools);
		expect(html).not.toContain("deployment_finish");
		expect(html.match(/data-deployment-id=/gu)).toHaveLength(1);
	});

	it("keeps an Assistant failure once when the same message contains a finished deployment", () => {
		const call = finishCall("success");
		if (call.message.role !== "assistant") throw new Error("Expected Assistant fixture");
		call.message.errorMessage = "Provider failed after finishing the tool";
		const html = render([call, finish("success"), finishResult("success")]);
		expect(html.match(/Provider failed after finishing the tool/gu)).toHaveLength(1);
		expect(html.match(/data-deployment-id=/gu)).toHaveLength(1);
		expect(html.indexOf("After finish")).toBeLessThan(html.indexOf("Provider failed after finishing the tool"));
	});

	it("shows only one card when an idempotent finish is called again", () => {
		const call = finishCall("success");
		const result = finishResult("success");
		if (call.message.role !== "assistant" || result.message.role !== "toolResult") throw new Error("Expected tool fixtures");
		call.message.content.push({ type: "toolCall", id: "finish-again", name: "deployment_finish", arguments: { outcome: "success" } });
		const repeated: ChatMessage = { ...result, id: "finish-again-result", sequence: 6, message: { ...result.message, toolCallId: "finish-again" } };
		const html = render([call, finish("success"), result, repeated]);
		expect(html.match(/data-deployment-id=/gu)).toHaveLength(1);
		expect(html).not.toContain("deployment_finish");
	});

	it.each([
		{ name: "tool error", result: finishResult("success", { isError: true }), outcome: "success" as const },
		{ name: "malformed result", result: finishResult("success", { text: "Cannot finish: incomplete stage" }), outcome: "success" as const },
		{ name: "another deployment", result: finishResult("success", { deploymentId: "other" }), outcome: "success" as const },
		{ name: "mismatched outcome", result: finishResult("failed"), outcome: "success" as const },
		{ name: "cancelled deployment", result: finishResult("cancelled"), outcome: "cancelled" as const },
	])("preserves the ordinary finish tool for $name", ({ result, outcome }) => {
		const html = render([finishCall("success"), finish(outcome), result]);
		expect(html).toContain("deployment_finish");
		expect(html.match(/data-deployment-id=/gu)).toHaveLength(1);
	});

	it("preserves a running finish tool even if a deployment event has already arrived", () => {
		const html = render([finishCall("success"), finish("success")], "en-US", { finish: { toolCallId: "finish", toolName: "deployment_finish", status: "running" } });
		expect(html).toContain("deployment_finish");
	});

	it.each(["success", "failed", "cancelled"] as const)("renders one %s result after discussion and before later conversation", (outcome) => {
		const messages = [user("Discuss this release", 2, 200), user("Check the service", 3, 300), finish(outcome), user("Next question", 5, 500)];
		expect(ids(conversationHistory(timeline(messages)))).toEqual(["persisted:Discuss this release", "persisted:Check the service", "release", "persisted:Next question"]);
		const html = render(messages);
		expect(html.match(/data-deployment-id=/gu)).toHaveLength(1);
		expect(html.indexOf("Check the service")).toBeLessThan(html.indexOf('class="deployment-history-card"'));
		expect(html.indexOf('class="deployment-history-card"')).toBeLessThan(html.indexOf("Next question"));
		expect(html).toContain(`data-status="${outcome}"`);
		expect(html).toContain('class="deployment-history-card-status"');
		expect(html).not.toContain("chat-command-card");
		expect(html).not.toContain("progressbar");
	});

	it("moves the live entry once and rejects a late start event or old history page", () => {
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages: [start, user("Discussion", 2, 200)] });
		state = chatRuntimeReducer(state, { type: "mergePersisted", messages: [finish("success")] });
		state = chatRuntimeReducer(state, { type: "mergePersisted", messages: [start] });
		expect(state.timeline).toHaveLength(2);
		expect(state.timeline[1]).toMatchObject({ sequence: 4, message: { details: { outcome: "success" } } });
		state = chatRuntimeReducer(state, { type: "mergePersisted", messages: [user("Older page", 0, 50), start] });
		expect(state.timeline.at(-1)?.sequence).toBe(4);
		expect(state.timeline.filter((entry) => entry.message.role === "custom")).toHaveLength(1);
		state = chatRuntimeReducer(state, { type: "hydrate", messages: [start, user("Discussion", 2, 200)] });
		expect(state.timeline.at(-1)).toMatchObject({ sequence: 4, message: { details: { outcome: "success" } } });
	});

	it("keeps the backend anchor position for a legacy entry without sorting it again", () => {
		const old = { ...finish("failed", "history"), sequence: 2, historyOrder: 1 as const };
		expect(ids(conversationHistory(timeline([old, user("Discussion", 2, 200), user("Later", 3, 500)]))))
			.toEqual(["persisted:Discussion", "release", "persisted:Later"]);
	});

	it.each(["en-US", "zh-CN"] as const)("shows only service, duration and a visual result in %s without a plan", (locale) => {
		const html = render([finish("failed")], locale);
		expect(html).toContain("AI Web API");
		expect(html).toContain("00:00");
		expect(html).toContain(locale === "en-US" ? "Deployment failed" : "部署失败");
		expect(html).not.toContain("Health check returned HTTP 503");
		expect(html).not.toContain(locale === "en-US" ? "View details" : "查看详情");
		expect(html).not.toContain('class="deployment-history-card-meta"');
		expect(html).not.toContain("<time");
		expect(html).not.toContain("undefined");
	});

	it("preserves ordinary transfer tool entries beside the deployment result", () => {
		const transfer: ChatTimelineEntry = { key: "transfer", sequence: 2, final: true, message: { role: "assistant", timestamp: 200,
			provider: "test", model: "test", stopReason: "toolUse", content: [{ type: "toolCall", id: "upload", name: "sftp_upload", arguments: { sourceFilePath: "/local/file", targetPath: "/remote/file" } }] } };
		const entries = conversationHistory([transfer, timeline([finish("success")])[0]!]);
		expect(entries.find((entry) => entry.kind === "message")?.entry).toBe(transfer);
		expect(entries.filter((entry) => entry.kind === "deploymentMessage")).toHaveLength(1);
	});

	it("receives a scoped message update through the deployment stream", async () => {
		const listeners = new Map<string, (event: MessageEvent) => void>();
		const close = vi.fn();
		vi.stubGlobal("EventSource", class { addEventListener(type: string, listener: (event: MessageEvent) => void) { listeners.set(type, listener); } close = close; });
		const onMessage = vi.fn();
		try {
			const dispose = subscribeDeploymentEvents({ sessionId: "session", workspaceId: "workspace", locale: "en-US",
				onRun: vi.fn(), onDiscussion: vi.fn(), onTask: vi.fn(), onLog: vi.fn(), onReconnect: vi.fn(), onMessage });
			await Promise.resolve();
			const send = (sessionId: string) => listeners.get("deployment.message.updated")!(new MessageEvent("deployment.message.updated", { data: JSON.stringify({ sessionId, message: finish("success") }) }));
			send("other"); expect(onMessage).not.toHaveBeenCalled();
			send("session"); expect(onMessage).toHaveBeenCalledWith(finish("success"));
			dispose(); expect(close).toHaveBeenCalledOnce();
		} finally { vi.unstubAllGlobals(); }
	});
});
