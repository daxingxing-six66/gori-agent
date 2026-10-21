import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatMessageRow } from "../features/chat/components/chat-message";
import { chatRuntimeReducer, initialChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import type { ChatMessage, ChatToolExecution, ToolCallContent } from "../features/chat/model/chat";
import { enUSMessages } from "../features/i18n/messages/en-US";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const questions = ["本轮运行多久？", "结果保存在哪里？", "是否自动续费？"];
const option = { label: "运行 30 分钟", description: "先做 **短片对照**，再检查 `720×1280` 的结果。" };
const call: ToolCallContent = { type: "toolCall", id: "decision-call", name: "ask_user_decision", arguments: {
	questions: questions.map((question) => ({ question, options: [option], recommendedIndex: 0 })),
} };
const answers = [
	{ question: questions[0], kind: "option", optionIndex: 0, option },
	{ question: questions[1], kind: "custom", text: "保存到 **本地**\n\n- 保留日志\n- 保留结果" },
	{ question: questions[2], kind: "skipped" },
];
const assistant: ChatMessage = { id: "assistant", sequence: 1, createdAt: 1, message: {
	role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1, content: [call],
} };
const execution: ChatToolExecution = { toolCallId: call.id, toolName: call.name, status: "completed", startedAt: 10, finishedAt: 110 };

function render(tools: Record<string, ChatToolExecution>, locale: "zh-CN" | "en-US" = "zh-CN", tool = call) {
	return renderToStaticMarkup(<IntlProvider locale={locale} messages={locale === "zh-CN" ? zhCNMessages : enUSMessages}>
		<ChatMessageRow entry={{ key: "assistant", final: true, message: { ...assistant.message, role: "assistant", content: [tool], provider: "test", model: "test", stopReason: "toolUse" } }}
			tools={tools} approvals={{}} approvalMutationId={null} onResolveApproval={() => {}} />
	</IntlProvider>);
}

describe("user decision history card", () => {
	it.each(["live", "history"] as const)("formats question and answer pairs from %s tool results", (source) => {
		const content = [{ type: "text" as const, text: JSON.stringify({ answers }) }];
		const state = source === "live"
			? chatRuntimeReducer(initialChatRuntimeState, { type: "event", event: { type: "tool_execution_end", data: {
				type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: { content, details: {} }, isError: false,
			} } })
			: chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages: [assistant, {
				id: "result", sequence: 2, createdAt: 2, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError: false, timestamp: 2 },
			}] });
		const html = render(state.tools);
		for (const [index, question] of questions.entries()) {
			expect(html).toContain(`问题 ${index + 1}`);
			expect(html).toContain(question);
		}
		expect(html.match(/用户回答/g)).toHaveLength(3);
		expect(html).toContain(option.label);
		expect(html).toContain("<strong>短片对照</strong>");
		expect(html).toContain("<code>720×1280</code>");
		expect(html).toContain("保存到 <strong>本地</strong>");
		expect(html).toContain("<li>保留日志</li>");
		expect(html).toContain("已跳过本题");
		expect(html).not.toContain("&quot;answers&quot;");
		expect(html).not.toContain("optionIndex");
		expect(html).not.toContain("<pre");
		expect(html).toContain('<details class="chat-tool-line');
	});

	it.each([undefined, "waiting", "running"] as const)("shows unanswered questions while status is %s", (status) => {
		const html = render(status ? { [call.id]: { ...execution, status } } : {});
		expect(html.match(/等待用户回答/g)).toHaveLength(3);
		expect(html).not.toContain(option.label);
		expect(html).not.toContain("已跳过本题");
	});

	it("preserves errors and never presents an error payload as a user answer", () => {
		const html = render({ [call.id]: { ...execution, status: "failed", isError: true, result: "User decision wait was cancelled" } });
		expect(html).toContain('role="alert"');
		expect(html).toContain("User decision wait was cancelled");
		expect(html.match(/未记录有效回答/g)).toHaveLength(3);
		expect(html).not.toContain("等待用户回答");
	});

	it.each(["not JSON", JSON.stringify({ answers: [] }), JSON.stringify({ answers: [...answers].reverse() })])("keeps malformed or mismatched results available without attributing an answer: %s", (result) => {
		const html = render({ [call.id]: { ...execution, result } });
		expect(html.match(/未记录有效回答/g)).toHaveLength(3);
		expect(html).toContain("<summary class=\"cursor-pointer text-xs\">输出</summary>");
		expect(html).not.toContain("<strong>短片对照</strong>");
	});

	it("keeps invalid or partial request arguments readable without crashing", () => {
		const html = render({}, "zh-CN", { ...call, arguments: { questions: [{ question: "已收到的问题" }, null] } });
		expect(html).toContain("已收到的问题");
		expect(html).toContain("<pre");
	});

	it("localizes answer labels and retains the existing completed status and duration", () => {
		const html = render({ [call.id]: { ...execution, result: JSON.stringify({ answers }) } }, "en-US");
		expect(html).toContain("Question 1");
		expect(html).toContain("Your answer");
		expect(html).toContain("Question skipped");
		expect(html).toContain("Completed");
		expect(html).toContain("100 ms");
	});

	it("keeps untrusted HTML escaped in questions and answers", () => {
		const question = "<script>alert('question')</script>";
		const html = render({ [call.id]: { ...execution, result: JSON.stringify({ answers: [{ question, kind: "custom", text: "<img src=x onerror=alert(1)>" }] }) } },
			"zh-CN", { ...call, arguments: { questions: [{ question }] } });
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
	});
});
