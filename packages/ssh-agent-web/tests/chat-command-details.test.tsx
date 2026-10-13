import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatMessageRow } from "../features/chat/components/chat-message";
import type { ChatToolExecution, ToolCallContent } from "../features/chat/model/chat";
import { chatRuntimeReducer, initialChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import { parseChatStreamEvent } from "../features/chat/runtime/chat-event-stream";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

function render(call: ToolCallContent, execution?: ChatToolExecution, locale: "zh-CN" | "en-US" = "zh-CN") {
	return renderToStaticMarkup(<IntlProvider locale={locale} messages={locale === "zh-CN" ? zhCNMessages : enUSMessages}>
		<ChatMessageRow entry={{ key: "message", final: true, message: {
			role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1, content: [call],
		} }} tools={execution ? { [call.id]: execution } : {}} approvals={{}} approvalMutationId={null} onResolveApproval={() => {}} />
	</IntlProvider>);
}

describe("command tool details", () => {
	it.each(["zh-CN", "en-US"] as const)("formats existing SSH request fields and preserves zero exit codes in %s", (locale) => {
		const call: ToolCallContent = { type: "toolCall", id: "ssh", name: "remote_server_call", arguments: {
			command: "printf 'a\\n'\n  printf 'b\\n'", cwd: "/software/中文 目录", timeoutMs: 10000,
			sandbox_permissions: "workspace_write", write_paths: ["/software/输出.txt"], extra: { value: false },
		} };
		const html = render(call, { toolCallId: call.id, toolName: call.name, status: "completed", result: "a\n  b\n", details: { exitCode: 0, outputTruncated: true } }, locale);
		expect(html).toContain(locale === "zh-CN" ? "工作目录" : "Working directory");
		expect(html).toContain("/software/中文 目录");
		expect(html).toContain("10,000 ms");
		expect(html).toContain("/software/输出.txt");
		expect(html).toContain("extra");
		expect(html).toContain("{&quot;value&quot;:false}");
		expect(html).toContain(locale === "zh-CN" ? "退出码</dt><dd>0" : "Exit code</dt><dd>0");
		expect(html).toContain(locale === "zh-CN" ? "已截断" : "Truncated");
		expect(html).toContain("a\n  b\n</pre>");
		expect(html).not.toContain("cwd=");
		expect(html).not.toContain("timeoutMs=");
	});

	it("does not synthesize missing request fields, exit codes, or truncation", () => {
		const call: ToolCallContent = { type: "toolCall", id: "ssh", name: "remote_server_call", arguments: { command: "pwd" } };
		const html = render(call, { toolCallId: call.id, toolName: call.name, status: "completed", result: "/software", details: "legacy" });
		expect(html).toContain("$ pwd");
		expect(html).not.toContain("工作目录");
		expect(html).not.toContain("超时");
		expect(html).not.toContain("退出码");
		expect(html).not.toContain("已截断");
	});

	it.each([
		[{ action: "submit", input: "  echo '<原文>'\n\techo done", expectation: "finite" }, "终端输入", "  echo &#x27;&lt;原文&gt;&#x27;\n\techo done"],
		[{ action: "key", key: "CTRL_C", expectation: "interactive" }, "快捷键", "Ctrl+C"],
		[{ action: "observe", expectation: "streaming" }, "终端输出", "running…"],
	] as const)("preserves terminal action semantics for %j", (args, label, expected) => {
		const call: ToolCallContent = { type: "toolCall", id: "terminal", name: "terminal_interaction", arguments: args };
		const html = render(call, { toolCallId: call.id, toolName: call.name, status: "completed", result: "running…\n", details: { truncated: true, exitCode: 0 } });
		expect(html).toContain(label);
		expect(html).toContain(expected);
		expect(html).toContain("终端输出");
		expect(html).toContain("running…\n</pre>");
		expect(html).not.toContain("退出码");
		expect(html).not.toContain("命令执行完成");
	});

	it.each(["zh-CN", "en-US"] as const)("hides terminal action and expectation rows in %s without changing tool arguments", (locale) => {
		for (const args of [
			{ action: "submit", input: "echo ok", expectation: "finite" },
			{ action: "key", key: "CTRL_C", expectation: "interactive" },
			{ action: "observe", expectation: "streaming" },
		]) {
			const call: ToolCallContent = { type: "toolCall", id: "terminal", name: "terminal_interaction", arguments: args };
			const original = JSON.stringify(args);
			const html = render(call, { toolCallId: call.id, toolName: call.name, status: "completed", result: "raw output\n" }, locale);
			expect(html).not.toContain('class="chat-command-parameters"');
			expect(html).toContain("raw output\n</pre>");
			expect(JSON.stringify(call.arguments)).toBe(original);
		}
	});

	it("keeps invalid combinations and unknown parameters visible rather than dropping diagnostics", () => {
		const call: ToolCallContent = { type: "toolCall", id: "terminal", name: "terminal_interaction", arguments: {
			action: "submit", input: "ls", key: "CTRL_C", expectation: "future_mode", constructor: "value", extra: null,
		} };
		const html = render(call, { toolCallId: call.id, toolName: call.name, status: "failed", result: "Contradictory parameters" });
		expect(html).toContain("Ctrl+C");
		expect(html).not.toContain("future_mode");
		expect(html).toContain("constructor");
		expect(html).toContain("null");
		expect(html).toContain("Contradictory parameters");
	});

	it("projects existing Chat SSE tool output and persisted results consistently without dispatching Terminal SSE", () => {
		const call: ToolCallContent = { type: "toolCall", id: "ssh", name: "remote_server_call", arguments: { command: "pwd" } };
		const result = { content: [{ type: "text" as const, text: "原始输出\n  空白保持\n" }], details: { exitCode: 0 } };
		let state = initialChatRuntimeState;
		for (const [type, data] of [
			["tool_execution_start", { toolCallId: call.id, toolName: call.name, args: call.arguments }],
			["tool_execution_update", { toolCallId: call.id, toolName: call.name, update: { type: "text", detail: { content: "运行中\n", mode: "replace" } } }],
			["tool_execution_end", { toolCallId: call.id, toolName: call.name, result, isError: false }],
		] as const) {
			const event = parseChatStreamEvent(type, data);
			expect(event).not.toBeNull();
			if (event) state = chatRuntimeReducer(state, { type: "event", event });
		}
		const persisted = chatRuntimeReducer(initialChatRuntimeState, { type: "hydrate", messages: [{ id: "result", sequence: 2, createdAt: 2,
			message: { role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: 2, isError: false, ...result },
		}] });
		for (const execution of [state.tools.ssh, persisted.tools.ssh]) {
			const html = render(call, execution);
			expect(html).toContain("原始输出\n  空白保持\n</pre>");
			expect(html).toContain("退出码</dt><dd>0");
			expect(html).not.toContain("&quot;content&quot;");
		}
		expect(parseChatStreamEvent("terminal.output", { bytesBase64: "aGVsbG8=" })).toBeNull();
	});
});
