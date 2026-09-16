import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { NoticeCard } from "../components/notice-card";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

describe("generic notice card", () => {
	it("shows a loading circle and hides dismissal while processing", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(NoticeCard, { tone: "info", loading: true, message: "正在压缩上下文…", onDismiss: () => {} })));
		expect(html).toContain("motion-safe:animate-spin");
		expect(html).toContain('role="status"');
		expect(html).toContain("正在压缩上下文…");
		expect(html).not.toContain("<button");
	});
	it("preserves multiline server text and only provides a dismiss icon", () => {
		const message = "上下文压缩失败\nupstream returned <error>";
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(NoticeCard, { tone: "error", message, onDismiss: () => {} })));
		expect(html).toContain("上下文压缩失败\nupstream returned &lt;error&gt;");
		expect(html).toContain('role="alert"');
		expect(html).toContain('aria-label="关闭"');
		expect(html.match(/<button /g)).toHaveLength(1);
		expect(html).toContain("whitespace-pre-wrap");
		expect(html).toContain("[overflow-wrap:anywhere]");
		expect(html).not.toContain("absolute");
		expect(html).not.toContain("重试");
	});
	it("localizes dismiss without translating backend errors", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "en-US", messages: enUSMessages }, createElement(NoticeCard, { tone: "error", message: "后端原始错误", onDismiss: () => {} })));
		expect(html).toContain('aria-label="Close"');
		expect(html).toContain("后端原始错误");
	});
	it("uses a calm information color and polite status for non-errors", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(NoticeCard, { tone: "info", message: "当前没有可压缩的上下文。", onDismiss: () => {} })));
		expect(html).toContain('role="status"');
		expect(html).toContain("text-[var(--accent)]");
		expect(html).not.toContain("var(--danger");
		expect(html).toContain("当前没有可压缩的上下文。");
		expect(html.match(/<button /g)).toHaveLength(1);
	});
});
