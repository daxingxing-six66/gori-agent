import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatMessageRow } from "../features/chat/components/chat-message";
import { UserDecisionPanel } from "../features/chat/components/user-decision-panel";
import type { ChatTimelineEntry } from "../features/chat/model/chat-runtime-state";
import type { UserDecision } from "../features/chat/model/user-decision";
import { enUSMessages } from "../features/i18n/messages/en-US";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const decision: UserDecision = {
	id: "decision-1", sessionId: "session-1", runId: "run-1", toolCallId: "call-1",
	status: "pending", createdAt: 1,
	questions: [{
		question: "本次如何部署？",
		options: [
			{ label: "直接部署", description: "使用当前配置" },
			{ label: "先检查", description: "确认当前状态" },
			{ label: "暂缓", description: "稍后处理" },
		],
		recommendedIndex: 1,
	}],
};

function renderDecision(locale: "zh-CN" | "en-US") {
	return renderToStaticMarkup(<IntlProvider locale={locale} messages={locale === "zh-CN" ? zhCNMessages : enUSMessages}>
		<UserDecisionPanel decision={decision} open busy={false} error={null} onClose={() => {}} onSubmit={async () => true} />
	</IntlProvider>);
}

describe("chat UI hierarchy", () => {
	it("shows compact unselected choices and visual progress without an early submit action", () => {
		const html = renderDecision("zh-CN");
		expect(html).toContain('role="group"');
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="0"');
		expect(html.match(/aria-pressed="false"/g)).toHaveLength(4);
		expect(html).toContain("已回答 0 / 1");
		expect(html).toContain('role="img" aria-label="推荐"');
		expect(html).not.toContain('type="radio"');
		expect(html).not.toContain("<textarea");
		expect(html).not.toContain("提交决定");
		expect(renderDecision("en-US")).toContain("0 of 1 answered");
	});

	it("keeps completed tool calls on one compact line with full details available on demand", () => {
		const entry: ChatTimelineEntry = {
			key: "assistant-1", final: true,
			message: { role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
				content: [
					{ type: "toolCall", id: "call-1", name: "remote_server_call", arguments: { command: "pwd" } },
					{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "/work/project/README.md" } },
				] },
		};
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatMessageRow entry={entry} tools={{
				"call-1": { toolCallId: "call-1", toolName: "remote_server_call", status: "completed", result: "/work/project" },
				"call-2": { toolCallId: "call-2", toolName: "read", status: "completed", result: "# Project" },
			}}
				approvals={{}} approvalMutationId={null} onResolveApproval={() => {}} />
		</IntlProvider>);
		expect(html).toContain("chat-tool-only");
		expect(html.match(/<details class="chat-tool-line/g)).toHaveLength(2);
		const summaries = [...html.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)].map((match) => match[1]);
		expect(summaries[0]).toContain("已运行");
		expect(summaries[0]).toContain("pwd");
		expect(summaries[1]).toContain("已读取");
		expect(summaries[1]).toContain("README.md");
		expect(summaries.join(" ")).not.toContain("本地命令");
		expect(summaries.join(" ")).not.toContain("展开工具输出");
		expect(html).toContain("$ pwd");
		expect(html).toContain("/work/project");
		expect(html).not.toContain('<details open=""');
	});

	it("keeps failed clues visible and pending approvals actionable", () => {
		const entry: ChatTimelineEntry = {
			key: "assistant-2", final: true,
			message: { role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
				content: [
					{ type: "toolCall", id: "failed-call", name: "remote_server_call", arguments: { command: "pwd" } },
					{ type: "toolCall", id: "approval-call", name: "remote_server_call", arguments: { command: "rm -rf /tmp/test", sandbox_permissions: "full_access" } },
				] },
		};
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatMessageRow entry={entry}
				tools={{ "failed-call": { toolCallId: "failed-call", toolName: "remote_server_call", status: "failed", result: "permission denied" } }}
				approvals={{ "approval-1": {
					id: "approval-1", sessionId: "session-1", runId: "run-1", assistantMessageId: "assistant-2", toolCallId: "approval-call",
					toolName: "remote_sandbox_exception", description: "批准后命令将不受远端沙箱约束，仅限本次调用。", status: "pending", createdAt: 1,
				} }} approvalMutationId={null} targetHost="server.example:22" onResolveApproval={() => {}} />
		</IntlProvider>);
		expect(html).toContain("运行失败");
		expect(html).toContain("permission denied");
		expect(html).toContain('class="chat-tool-approval');
		expect(html).toContain("rm -rf /tmp/test");
		expect(html).toContain("目标主机 · server.example:22");
		expect(html).toContain("sandbox_permissions=full_access");
		expect(html).toContain("批准后命令将不受远端沙箱约束，仅限本次调用。");
		expect(html).toContain("无远端文件系统沙箱 · 仅本次调用");
		expect(html).toContain("批准无沙箱执行");
		expect(html).toContain("拒绝本次");
		expect(html).toContain("完整请求参数");
		expect(html).toContain('tabindex="0"');
	});

	it("keeps both approval decisions visible but disabled while a decision is processing", () => {
		const entry: ChatTimelineEntry = {
			key: "assistant-3", final: true,
			message: { role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
				content: [{ type: "toolCall", id: "upload-call", name: "sftp_upload", arguments: { sourceFilePath: "/tmp/app.jar", targetPath: "/opt/app.jar" } }] },
		};
		const renderApproval = (busy: boolean) => renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatMessageRow entry={entry} tools={{}} approvals={{ "approval-2": {
				id: "approval-2", sessionId: "session-1", runId: "run-1", assistantMessageId: "assistant-3", toolCallId: "upload-call",
				toolName: "sftp_upload", description: "将覆盖远端文件", status: "pending", createdAt: 1,
			} }} approvalMutationId={busy ? "approval-2" : null} onResolveApproval={() => {}} />
		</IntlProvider>);
		const html = renderApproval(true);
		expect(html).toContain('aria-busy="true"');
		expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
		expect(html).toContain("拒绝覆盖");
		expect(html).toContain("处理中");
		expect(renderApproval(false)).toContain("批准覆盖");
	});
});
