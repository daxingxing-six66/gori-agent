import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

function render(showActivity: boolean, locale: "zh-CN" | "en-US" = "zh-CN") {
	return renderToStaticMarkup(createElement(IntlProvider, { locale, messages: locale === "zh-CN" ? zhCNMessages : enUSMessages }, createElement(ChatTimeline, {
		showActivity, loading: false, loadingOlderMessages: false, timeline: [], tools: {}, approvals: {}, approvalMutationId: null, run: null, latestUserText: "", onResolveApproval: () => {}, onRestoreDraft: () => {},
	})));
}

describe("chat timeline activity", () => {
	it("shows three staggered CSS dots without the empty welcome while waiting", () => {
		const html = render(true);
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="正在运行"');
		expect(html.match(/motion-safe:animate-pulse/g)).toHaveLength(3);
		expect(html).toContain("h-9 w-full items-center justify-center");
		expect(html).not.toContain("border");
		expect(html).toContain("animation-delay:160ms");
		expect(html).toContain("animation-delay:320ms");
		expect(html).not.toContain(zhCNMessages["chat.empty.title"]);
	});
	it("removes the activity when inactive and localizes its accessible label", () => {
		expect(render(false)).not.toContain('role="status"');
		expect(render(false)).toContain(zhCNMessages["chat.empty.title"]);
		expect(render(true, "en-US")).toContain('aria-label="Running"');
	});
});
