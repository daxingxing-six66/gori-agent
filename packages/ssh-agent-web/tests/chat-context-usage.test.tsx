import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApi } from "../features/chat/api/chat-api";
import { ChatContextUsageIndicator } from "../features/chat/components/chat-context-usage-indicator";
import { isChatContextUsage, type ChatContextUsage } from "../features/chat/model/chat-context-usage";
import { ChatContextUsageStore } from "../features/chat/runtime/chat-context-usage-store";
import { parseChatStreamEvent } from "../features/chat/runtime/chat-event-stream";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

const usage: ChatContextUsage = { contextTokens: 42800, contextWindow: 200000, usagePercent: 21.4, source: "estimated", providerId: "provider", modelId: "model" };

function pendingQuery() {
	let resolve!: (value: { contextUsage: ChatContextUsage | null }) => void;
	const promise = new Promise<{ contextUsage: ChatContextUsage | null }>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("context usage snapshots", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("queries the Session snapshot without caching and reads manual compaction usage", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ contextUsage: usage })))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: "skipped", reason: "nothing_to_compact", attempts: 0, contextUsage: null })));
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		expect(await chatApi.getContextUsage("session / 1", controller.signal)).toEqual({ contextUsage: usage });
		expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/sessions/session%20%2F%201/chat/context-usage");
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", cache: "no-store", signal: controller.signal });
		expect((await chatApi.compact("session / 1")).contextUsage).toBeNull();
	});
	it("validates the direct SSE snapshot and permits overflow", () => {
		expect(parseChatStreamEvent("context.updated", usage)).toEqual({ type: "context.updated", data: usage });
		expect(isChatContextUsage({ ...usage, usagePercent: 120 })).toBe(true);
		for (const invalid of [{ contextUsage: usage }, { ...usage, contextWindow: 0 }, { ...usage, contextTokens: -1 }, { ...usage, usagePercent: NaN }]) {
			expect(parseChatStreamEvent("context.updated", invalid)).toBeNull();
		}
	});

	it("loads an inactive Session and replaces rather than accumulates pushed snapshots", async () => {
		const store = new ChatContextUsageStore(async () => ({ contextUsage: usage }));
		await store.refresh();
		expect(store.getSnapshot()).toEqual(usage);
		const compacted = { ...usage, contextTokens: 1000, usagePercent: 0.5 };
		store.apply(compacted);
		expect(store.getSnapshot()).toEqual(compacted);
		store.apply(null);
		expect(store.getSnapshot()).toBeNull();
	});

	it("does not replace an SSE or manual compaction snapshot with a late query", async () => {
		const query = pendingQuery();
		const store = new ChatContextUsageStore(() => query.promise);
		const request = store.refresh();
		const newer = { ...usage, contextTokens: 500 };
		store.apply(newer);
		query.resolve({ contextUsage: usage });
		await request;
		expect(store.getSnapshot()).toEqual(newer);
	});

	it("allows setup-cleanup-setup and ignores the aborted request even when it resolves", async () => {
		const old = pendingQuery();
		const latest = pendingQuery();
		const query = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
		const store = new ChatContextUsageStore(query);
		const first = store.refresh();
		store.cancel();
		expect(query.mock.calls[0]?.[0].aborted).toBe(true);
		const second = store.refresh();
		latest.resolve({ contextUsage: usage });
		await second;
		old.resolve({ contextUsage: null });
		await first;
		expect(store.getSnapshot()).toEqual(usage);
	});

	it("keeps Session stores isolated and handles unavailable data", async () => {
		const first = new ChatContextUsageStore(async () => ({ contextUsage: usage }));
		const second = new ChatContextUsageStore(async () => { throw new Error("offline"); });
		await Promise.all([first.refresh(), second.refresh()]);
		expect(first.getSnapshot()).toEqual(usage);
		expect(second.getSnapshot()).toBeNull();
	});

	it("hides null usage and preserves actual overflow in the localized accessible label", () => {
		for (const [locale, messages, label] of [["zh-CN", zhCNMessages, "约 120% 已用"], ["en-US", enUSMessages, "Approximately 120% used"]] as const) {
			const render = (value: ChatContextUsage | null) => renderToStaticMarkup(createElement(IntlProvider, { locale, messages }, createElement(ChatContextUsageIndicator, { usage: value })));
			expect(render(null)).toBe("");
			const html = render({ ...usage, usagePercent: 120 });
			expect(html).toContain(label);
			expect(html).toContain('stroke-dasharray="100 100"');
		}
	});
});
