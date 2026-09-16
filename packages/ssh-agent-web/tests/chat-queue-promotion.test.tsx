import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { QueuePreview } from "../features/chat/components/chat-composer-panel";
import { chatApi } from "../features/chat/api/chat-api";
import { chatRuntimeReducer, initialChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

describe("follow-up promotion", () => {
	it.each([1, 4, 5])("keeps all %i items in a four-row scroll viewport", (count) => {
		const items = Array.from({ length: count }, (_, index) => ({ id: String(index), behavior: "follow_up" as const, status: "pending" as const, message: "next" }));
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<QueuePreview active items={items} mutationId={null} onCancel={() => {}} onPromote={() => {}} />
		</IntlProvider>);
		expect(html).toContain("grid max-h-[156px] auto-rows-[36px] gap-1 overflow-y-auto");
		expect(html.match(/lucide-corner-down-left/g)).toHaveLength(count);
	});
	it.each(["zh-CN", "en-US"] as const)("shows an icon-only steering action for pending follow-ups in %s", (locale) => {
		const html = renderToStaticMarkup(<IntlProvider locale={locale} messages={locale === "zh-CN" ? zhCNMessages : enUSMessages}>
			<QueuePreview active items={[{ id: "q", behavior: "follow_up", status: "pending", message: "next" }]} mutationId={null} onCancel={() => {}} onPromote={() => {}} />
		</IntlProvider>);
		expect(html).toContain("lucide-corner-down-left");
		expect(html).toContain(locale === "zh-CN" ? 'aria-label="立即引导"' : 'aria-label="Steer now"');
		expect(html.match(/<button /g)).toHaveLength(2);
		expect(html).not.toMatch(/>立即引导</);
	});
	it("does not offer promotion twice for a steering item", () => {
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<QueuePreview active items={[{ id: "q", behavior: "steer", status: "pending" }]} mutationId={null} onCancel={() => {}} onPromote={() => {}} />
		</IntlProvider>);
		expect(html).not.toContain("lucide-corner-down-left");
	});
	it("does not resurrect consumed items or downgrade steering after delayed responses", () => {
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "event", event: { type: "queue.updated", data: { id: "q", behavior: "steer", status: "consumed" } } });
		state = chatRuntimeReducer(state, { type: "event", event: { type: "queue.updated", data: { id: "q", behavior: "follow_up", status: "pending" } } });
		expect(state.queue.q).toMatchObject({ status: "consumed", behavior: "steer" });
		expect(state.timeline).toEqual([]);
	});
	it("converts the existing queue ID without enqueueing again", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "q", behavior: "steer" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await chatApi.promoteQueued("s", "r", "q");
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(fetchMock.mock.calls[0]![0]).toContain("/api/sessions/s/chat/runs/r/queue/q/steer");
			expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
		} finally { vi.unstubAllGlobals(); }
	});
});
