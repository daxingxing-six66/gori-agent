import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import type { ChatMessage, ChatToolExecution } from "../features/chat/model/chat";
import { chatRuntimeReducer, initialChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import { conversationHistory } from "../features/chat/model/conversation-history";
import { enUSMessages } from "../features/i18n/messages/en-US";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

function card(status: "active" | "completed" | "cancelled" = "completed", taskId = "task"): ChatMessage {
	return { id: `diagnose:${taskId}`, sequence: 4, createdAt: 400, message: {
		role: "custom", customType: "diagnose", content: "Intermittent 502", display: true, timestamp: 400,
		details: { taskId, title: "Intermittent 502", status, revision: 3 },
	} };
}
function call(): ChatMessage {
	return { id: "call", sequence: 3, createdAt: 300, message: {
		role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 300,
		content: [{ type: "text", text: "Before finish" }, { type: "toolCall", id: "finish", name: "diagnose_finish",
			arguments: { conclusionMarkdown: "# The full saved conclusion" } }, { type: "text", text: "After finish" },
			{ type: "toolCall", id: "read", name: "read", arguments: { path: "/app/log" } }],
	} };
}
const success = { taskId: "task", status: "completed", revision: 3, conclusionAvailable: true };
function result(value: unknown = success, isError = false): ChatMessage {
	return { id: "result", sequence: 5, createdAt: 500, message: { role: "toolResult", toolCallId: "finish", toolName: "diagnose_finish",
		isError, timestamp: 500, content: [{ type: "text", text: JSON.stringify(value) }] } };
}
function render(messages: ChatMessage[], options: { tools?: Record<string, ChatToolExecution>; loading?: boolean; locale?: "zh-CN" | "en-US" } = {}) {
	const state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages });
	const locale = options.locale ?? "en-US";
	return renderToStaticMarkup(createElement(IntlProvider, { locale, messages: locale === "en-US" ? enUSMessages : zhCNMessages },
		createElement(ChatTimeline, { timeline: state.timeline, tools: options.tools ?? state.tools, loading: options.loading ?? false,
			showActivity: false, loadingOlderMessages: false, approvals: {}, approvalMutationId: null, run: null,
			latestUserText: "", onResolveApproval: vi.fn(), onRestoreDraft: vi.fn(), onOpenDiagnose: vi.fn() })));
}

describe("diagnosis in unified Chat history", () => {
	it.each(["active", "completed", "cancelled"] as const)("echoes a %s task once in backend sequence order and hides it during initial loading", (status) => {
		const messages: ChatMessage[] = [
			{ id: "before", sequence: 1, createdAt: 1, message: { role: "user", content: "Earlier question", timestamp: 1 } }, card(status),
			{ id: "after", sequence: 6, createdAt: 600, message: { role: "user", content: "Later question", timestamp: 600 } },
		];
		const html = render(messages);
		expect(html.match(/data-diagnose-id=/gu)).toHaveLength(1);
		expect(html.indexOf("Earlier question")).toBeLessThan(html.indexOf('data-diagnose-id="task"'));
		expect(html.indexOf('data-diagnose-id="task"')).toBeLessThan(html.indexOf("Later question"));
		expect(render(messages, { loading: true })).not.toContain("data-diagnose-id");
		const state = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages });
		expect(conversationHistory(state.timeline).map((entry) => entry.kind)).toEqual(["message", "diagnoseMessage", "message"]);
	});
	it.each(["zh-CN", "en-US"] as const)("replaces a saved conclusion tool with the diagnosis card in %s, preserving sibling content", (locale) => {
		const messages = [call(), card(), result()]; const original = JSON.stringify(messages);
		const html = render(messages, { locale });
		expect(html.match(/data-diagnose-id=/gu)).toHaveLength(1); expect(html).not.toContain("diagnose_finish");
		expect(html.indexOf("Before finish")).toBeLessThan(html.indexOf('class="diagnose-history-card"'));
		expect(html.indexOf('class="diagnose-history-card"')).toBeLessThan(html.indexOf("After finish"));
		expect(html).toContain("/app/log"); expect(html).toContain(locale === "en-US" ? "View diagnosis" : "查看诊断记录");
		expect(html).not.toContain("The full saved conclusion"); expect(JSON.stringify(messages)).toBe(original);
	});
	it("accepts a live result envelope, waits for the exact card, and ignores non-JSON runtime notes", () => {
		const tools: Record<string, ChatToolExecution> = { finish: { toolCallId: "finish", toolName: "diagnose_finish", status: "completed",
			result: { content: [{ type: "text", text: JSON.stringify(success) }, { type: "text", text: "Runtime note" }] } } };
		expect(render([call()], { tools })).toContain("diagnose_finish");
		expect(render([call(), card()], { tools })).not.toContain("diagnose_finish");
		expect(render([call(), card()], { tools: { finish: { ...tools.finish!, status: "running" } } })).toContain("diagnose_finish");
	});
	it.each([
		{ name: "wrong task", value: { ...success, taskId: "other" } },
		{ name: "missing report", value: { ...success, conclusionAvailable: false } },
		{ name: "active result", value: { ...success, status: "active" } },
		{ name: "cancelled result", value: { ...success, status: "cancelled" } },
		{ name: "malformed result", value: "No report was saved" },
		{ name: "tool failure", value: success, isError: true },
		{ name: "active card", value: success, status: "active" as const },
		{ name: "cancelled card", value: success, status: "cancelled" as const },
	])("keeps the ordinary finish tool for $name", ({ value, isError, status }) => {
		const html = render([call(), card(status), result(value, isError)]);
		expect(html).toContain("diagnose_finish"); expect(html.match(/data-diagnose-id=/gu)).toHaveLength(1);
	});
	it("deduplicates idempotent completion tools and preserves an Assistant failure once", () => {
		const source = call(); if (source.message.role !== "assistant") throw new Error("Expected Assistant fixture");
		source.message.content.push({ type: "toolCall", id: "repeat", name: "diagnose_finish", arguments: { conclusionMarkdown: "Same report" } });
		source.message.errorMessage = "Provider failed after saving the report";
		const repeated = result(); if (repeated.message.role !== "toolResult") throw new Error("Expected result fixture");
		repeated.id = "repeat-result"; repeated.sequence = 6; repeated.message = { ...repeated.message, toolCallId: "repeat" };
		const html = render([source, card(), result(), repeated]);
		expect(html.match(/data-diagnose-id=/gu)).toHaveLength(1); expect(html).not.toContain("diagnose_finish");
		expect(html.match(/Provider failed after saving the report/gu)).toHaveLength(1);
		expect(html.indexOf("After finish")).toBeLessThan(html.indexOf("Provider failed after saving the report"));
	});
	it("shares placement with Deploy without confusing equal business IDs or losing mixed content", () => {
		const source = call(); if (source.message.role !== "assistant") throw new Error("Expected Assistant fixture");
		source.message.content.unshift({ type: "toolCall", id: "deploy-finish", name: "deployment_finish", arguments: { outcome: "success" } },
			{ type: "text", text: "Between tasks" });
		source.message.errorMessage = "One final failure";
		const deployment: ChatMessage = { id: "deployment:task", sequence: 2, createdAt: 200, message: {
			role: "custom", customType: "deployment", display: true, content: "API", timestamp: 200,
			details: { deploymentId: "task", title: "API", outcome: "success", startedAt: 100, finishedAt: 200 },
		} };
		const deployResult: ChatMessage = { id: "deploy-result", sequence: 7, createdAt: 700, message: {
			role: "toolResult", toolCallId: "deploy-finish", toolName: "deployment_finish", isError: false, timestamp: 700,
			content: [{ type: "text", text: JSON.stringify({ deploymentId: "task", outcome: "success", deploymentMode: false }) }],
		} };
		const html = render([deployment, source, card(), result(), deployResult]);
		expect(html.match(/data-deployment-id=/gu)).toHaveLength(1); expect(html.match(/data-diagnose-id=/gu)).toHaveLength(1);
		expect(html).not.toContain("deployment_finish"); expect(html).not.toContain("diagnose_finish");
		expect(html.indexOf('class="deployment-history-card"')).toBeLessThan(html.indexOf("Between tasks"));
		expect(html.indexOf("Between tasks")).toBeLessThan(html.indexOf('class="diagnose-history-card"'));
		expect(html).toContain("After finish"); expect(html).toContain("/app/log"); expect(html.match(/One final failure/gu)).toHaveLength(1);
	});
});
