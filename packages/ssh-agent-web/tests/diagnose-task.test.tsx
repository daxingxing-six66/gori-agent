import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { DiagnoseTaskPage } from "../features/diagnose/components/diagnose-task-page";
import { DiagnoseMarkdown } from "../features/diagnose/components/diagnose-markdown";
import { DiagnoseHistoryCard } from "../features/diagnose/components/diagnose-history-card";
import { diagnoseCommand } from "../features/diagnose/model/diagnose-command";
import type { DiagnoseView } from "../features/diagnose/runtime/use-diagnose-view";
import type { DiagnoseNode, DiagnoseTask } from "../features/diagnose/model/diagnose";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
const localized = (element: React.ReactNode) => renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, element));
const task: DiagnoseTask = { id: "t", sessionId: "s", workspaceId: "w", requestId: "r", title: "偶发 502", status: "active", revision: 3,
	currentSequence: 2, conclusionAvailable: false, createdAt: 1, updatedAt: 3 };
const nodes: DiagnoseNode[] = [1, 2].map((sequence) => ({ taskId: "t", sequence, direction: `方向 ${sequence}`, status: sequence === 1 ? "unconfirmed" : "diagnosing", explanation: `说明 ${sequence}`, revision: 1, createdAt: 1, updatedAt: 1 }));
const saved: DiagnoseView = { page: "records", expanded: {}, recordsScroll: 0, conclusionScroll: 0, seenSequence: 0 };
const view = { get: () => saved, update: vi.fn() };
const props = { sessionId: "s", taskId: "t", entry: { task, nodes, nextBeforeSequence: null, loaded: true }, busy: false, error: null, view,
	onConclude: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onOlder: async () => true };

describe("diagnosis task presentation", () => {
	it("renders chronological records, current expanded, status badges, and no percentage", () => {
		const html = localized(createElement(DiagnoseTaskPage, props));
		expect(html.indexOf("方向 1")).toBeLessThan(html.indexOf("方向 2")); expect(html).toContain('aria-expanded="false"'); expect(html).toContain('aria-expanded="true"');
		expect(html).toContain('class="diagnose-status" data-status="unconfirmed"'); expect(html).toContain("暂未确定"); expect(html).toContain("结束诊断"); expect(html).not.toContain("%");
		expect(html).toContain("复制记录");
	});
	it("provides Conclusion only after a report exists and never invents one after exit", () => {
		const completed = localized(createElement(DiagnoseTaskPage, { ...props, entry: { ...props.entry, task: { ...task, status: "completed", conclusionAvailable: true } } }));
		expect(completed).toContain(">结论</button>"); expect(completed).not.toContain("结束诊断"); expect(completed).not.toContain("diagnose-conclusion");
		const cancelled = localized(createElement(DiagnoseTaskPage, { ...props, entry: { ...props.entry, task: { ...task, status: "cancelled" } } }));
		expect(cancelled).not.toContain(">结论</button>"); expect(cancelled).not.toContain("直接退出诊断");
	});
	it("uses safe Markdown headings, tables and code without executing HTML or unsafe links", () => {
		const html = renderToStaticMarkup(createElement(DiagnoseMarkdown, { content: '# Report\n\n<script>alert(1)</script>\n\n| Fact | Result |\n|---|---|\n| A | B |\n\n```sh\necho check\n```\n\n[unsafe](javascript:alert(1)) [safe](https://example.org)' }));
		expect(html).toContain("<h1>Report</h1>"); expect(html).toContain("<table>"); expect(html).toContain("<pre>"); expect(html).not.toContain("<script"); expect(html).not.toContain("javascript:"); expect(html).toContain('rel="noreferrer noopener"');
	});
	it("keeps the unified history entry small and parses only the diagnose command", () => {
		const html = localized(createElement(DiagnoseHistoryCard, { identity: { taskId: "t", title: "偶发 502", status: "completed" }, onOpen: vi.fn() }));
		expect(html).toContain("查看诊断记录"); expect(html).not.toContain("说明 1");
		expect(diagnoseCommand("/diagnose 排查 502")).toEqual({ problem: "排查 502" }); expect(diagnoseCommand(" /diagnose ")).toEqual({ problem: "" }); expect(diagnoseCommand("/diagnoses")).toBeNull();
	});
});
