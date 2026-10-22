import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStatistics, isStatisticsResponse } from "../features/statistics/api/statistics-api";
import { groupTrendDays, StatisticsTrend } from "../features/statistics/components/statistics-trend";
import { StatisticsCalendar } from "../features/statistics/components/statistics-calendar";
import { StatisticsModelsTable } from "../features/statistics/components/statistics-models";
import { StatisticsCallsTable } from "../features/statistics/components/statistics-calls";
import { parseStatisticsLocation, statisticsParams } from "../features/statistics/model/statistics-location";
import type { StatisticsCallRow, StatisticsDay, StatisticsUsage } from "../features/statistics/model/statistics";
import { messagesByLocale } from "../features/i18n/messages/messages";

const now = Date.parse("2026-10-15T04:00:00Z");
const usage = (): StatisticsUsage => ({ input: 100, output: 20, cacheRead: 300, cacheWrite: 10,
	totalTokens: 430, calls: 1, usageSamples: 1, costSamples: 1,
	cost: { input: .001, output: .002, cacheRead: .003, cacheWrite: .004, total: .01 } });
const day = (date: string): StatisticsDay => ({ date, usage: usage(), runs: 1, active: true });
afterEach(() => { vi.unstubAllGlobals(); });

describe("statistics URL and client contracts", () => {
	it("restores tabs, filters and provider/model identity without collisions", () => {
		const params = new URLSearchParams({ tab: "models", range: "7d", workspaceId: "server / one", model: JSON.stringify(["provider / a", "same-name"]), year: "2024", modelSort: "tokens", direction: "asc" });
		const restored = parseStatisticsLocation(params, "Asia/Shanghai", now);
		expect(restored).toMatchObject({ tab: "models", range: "7d", workspaceId: "server / one", providerId: "provider / a", year: 2024, modelSort: "tokens", direction: "asc" });
		const query = statisticsParams(restored, now)!;
		expect(query.get("providerId")).toBe("provider / a");
		expect(query.get("modelId")).toBe("same-name");
		expect(query.get("from")).toBe(String(Date.parse("2026-10-08T16:00:00Z")));
		expect(query.get("to")).toBe(String(Date.parse("2026-10-15T16:00:00Z")));
	});

	it("filters an entire provider and discards models that conflict with an explicit provider", () => {
		const onlyProvider = parseStatisticsLocation(new URLSearchParams("providerId=two"), "UTC", now);
		expect(onlyProvider).toMatchObject({ providerId: "two", model: "" });
		expect(statisticsParams(onlyProvider, now)!.get("providerId")).toBe("two");
		expect(statisticsParams(onlyProvider, now)!.has("modelId")).toBe(false);
		const pair = JSON.stringify(["one", "same-name"]);
		for (const providerId of ["two", "", "x".repeat(513)]) {
			const restored = parseStatisticsLocation(new URLSearchParams({ providerId, model: pair }), "UTC", now);
			expect(restored.model).toBe("");
			expect(statisticsParams(restored, now)!.has("modelId")).toBe(false);
		}
		const match = parseStatisticsLocation(new URLSearchParams({ providerId: "one", model: pair }), "UTC", now);
		expect(statisticsParams(match, now)!.get("modelId")).toBe("same-name");
	});

	it("uses sensible defaults, rejects malformed custom ranges, and respects a DST day", () => {
		const defaults = parseStatisticsLocation(new URLSearchParams("tab=invalid&year=NaN&model=%7B%7D&timeZone=bad"), "UTC", now);
		expect(defaults).toMatchObject({ tab: "overview", range: "30d", year: 2026, model: "", timeZone: "Asia/Shanghai" });
		const custom = { ...defaults, range: "custom" as const, start: "2026-02-30", end: "2026-03-01" };
		expect(statisticsParams(custom, now)).toBeNull();
		expect(statisticsParams({ ...custom, start: "2026-03-03" }, now)).toBeNull();
		const dst = statisticsParams({ ...custom, start: "2026-03-08", end: "2026-03-08", timeZone: "America/New_York" }, now)!;
		expect(Number(dst.get("to")) - Number(dst.get("from"))).toBe(23 * 3600_000);
		const midnightChange = statisticsParams({ ...custom, start: "2018-11-04", end: "2018-11-04", timeZone: "America/Sao_Paulo" }, now)!;
		expect(Number(midnightChange.get("from"))).toBe(Date.parse("2018-11-04T03:00:00Z"));
	});

	it("restores the individual model call tab and its page cursor", () => {
		expect(parseStatisticsLocation(new URLSearchParams("tab=calls&cursor=next-page"), "UTC", now))
			.toMatchObject({ tab: "calls", cursor: "next-page" });
	});

	it("accepts only verifiable call cache metrics with a consistent actual-input ratio", async () => {
		const row = call();
		const result = (cache: StatisticsCallRow["cache"]) => ({ generatedAt: now, range: { from: 0, to: now, timeZone: "UTC" }, rows: [{ ...row, cache }], nextCursor: null });
		expect(isStatisticsResponse("call-records", result(row.cache))).toBe(true);
		for (const cache of [
			{ status: "reported", inputTokens: 100, cachedTokens: 101, hitRate: 1.01 },
			{ status: "reported", inputTokens: 100, cachedTokens: 90, hitRate: .8 },
			{ status: "reported", inputTokens: 1_000_000_000_000_000, cachedTokens: 1, hitRate: 0 },
			{ status: "reported", inputTokens: 0, cachedTokens: 0, hitRate: 0 },
			{ status: "reported", inputTokens: 10.5, cachedTokens: 0, hitRate: 0 },
			{ status: "unreported", inputTokens: 100, cachedTokens: 0, hitRate: 0 },
		]) expect(isStatisticsResponse("call-records", result(cache as StatisticsCallRow["cache"]))).toBe(false);
		expect(isStatisticsResponse("call-records", result({ status: "reported", inputTokens: 0, cachedTokens: 0, hitRate: null }))).toBe(true);
		expect(isStatisticsResponse("call-records", result({ status: "unreported", inputTokens: null, cachedTokens: null, hitRate: null }))).toBe(true);
		expect(isStatisticsResponse("call-records", result({ status: "invalid", inputTokens: null, cachedTokens: null, hitRate: null }))).toBe(true);
		expect(isStatisticsResponse("call-records", { ...result(row.cache), rows: [{ ...row, kind: "compact_summary" }] })).toBe(false);
		const fetchMock = vi.fn().mockResolvedValue(Response.json(result(row.cache)));
		vi.stubGlobal("fetch", fetchMock);
		await fetchStatistics("call-records", new URLSearchParams("cursor=next"), new AbortController().signal);
		expect(fetchMock.mock.calls[0][0]).toContain("/api/statistics/call-records?cursor=next");
	});

	it("validates responses instead of rendering malformed metrics", async () => {
		const payload = { workspaces: [{ id: "a", name: "Server", hostname: "test" }], models: [], earliestAt: null };
		expect(isStatisticsResponse("options", payload)).toBe(true);
		expect(isStatisticsResponse("options", { ...payload, earliestAt: NaN })).toBe(false);
		expect(isStatisticsResponse("models", { generatedAt: now, range: { from: 0, to: now, timeZone: "UTC" }, rows: [{ providerId: "a", modelId: "model", usage: { ...usage(), input: -1 } }] })).toBe(false);
		const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(payload)).mockResolvedValueOnce(Response.json({ invalid: true }));
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		expect(await fetchStatistics("options", new URLSearchParams(), controller.signal)).toEqual(payload);
		expect(fetchMock.mock.calls[0][0]).toContain("/api/statistics/options");
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal, cache: "no-store", headers: { "accept-language": "zh-CN" } });
		await expect(fetchStatistics("options", new URLSearchParams(), controller.signal)).rejects.toThrow("statistics_invalid_response");
	});
});

describe("statistics charts and bilingual presentation", () => {
	it.each(["zh-CN", "en-US"] as const)("shows exact API cache counts and distinguishes unknown from zero in %s", locale => {
		const render = (rows: StatisticsCallRow[]) => renderToStaticMarkup(<IntlProvider locale={locale} messages={messagesByLocale[locale]}><StatisticsCallsTable rows={rows} timeZone="UTC" /></IntlProvider>);
		const table = render([call(), { ...call(), id: "zero", cache: { status: "reported", inputTokens: 1000, cachedTokens: 0, hitRate: 0 } },
			{ ...call(), id: "full", kind: "compact", runId: null, cache: { status: "reported", inputTokens: 1000, cachedTokens: 1000, hitRate: 1 } }]);
		expect(table).toContain("90%");
		expect(table).toContain("0%");
		expect(table).toContain("100%");
		expect(table).toContain("900");
		expect(table).toContain("1,000");
		expect(table).toContain(locale === "zh-CN" ? "上下文压缩" : "Compaction");
		const missing = render([{ ...call(), cache: { status: "unreported", inputTokens: null, cachedTokens: null, hitRate: null } }]);
		expect(missing).toContain(locale === "zh-CN" ? "无可验证数据" : "No verifiable data");
		expect(missing).not.toContain("0%");
		const historical = render([{ ...call(), kind: "compact_summary", cache: { status: "unreported", inputTokens: null, cachedTokens: null, hitRate: null } }]);
		expect(historical).toContain(locale === "zh-CN" ? "历史压缩汇总" : "Historical compaction total");
		expect(historical).not.toContain("0%");
		const noInput = render([{ ...call(), cache: { status: "reported", inputTokens: 0, cachedTokens: 0, hitRate: null } }]);
		expect(noInput).toContain(locale === "zh-CN" ? "输入为 0" : "Zero input");
		expect(noInput).not.toContain(">0%<");
		const tiny = render([{ ...call(), cache: { status: "reported", inputTokens: 1_000_000, cachedTokens: 1, hitRate: .000001 } }]);
		expect(tiny).toContain("&lt;0.01%");
		const almostFull = render([{ ...call(), cache: { status: "reported", inputTokens: 1_000_000, cachedTokens: 999_999, hitRate: .999999 } }]);
		expect(almostFull).toContain("&gt;99.99%");
		expect(almostFull).not.toContain(">100%<");
	});
	it("groups weeks across month boundaries without mutating daily data", () => {
		const rows = [day("2026-09-30"), day("2026-10-01"), day("2026-10-05")];
		const grouped = groupTrendDays(rows, true);
		expect(grouped.map((point) => point.date)).toEqual(["2026-09-28", "2026-10-05"]);
		expect(grouped[0].usage.totalTokens).toBe(860);
		expect(grouped[0].usage.cost.total).toBeCloseTo(.02);
		expect(rows[0].usage.totalTokens).toBe(430);
	});

	it.each(["zh-CN", "en-US"] as const)("renders accessible model tables, trend and calendar in %s", (locale) => {
		const render = (element: React.ReactNode) => renderToStaticMarkup(<IntlProvider locale={locale} messages={messagesByLocale[locale]}>{element}</IntlProvider>);
		const missing = { ...usage(), usageSamples: 0, costSamples: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		const table = render(<StatisticsModelsTable rows={[{ providerId: "historical-provider", modelId: "very-long-model-name-".repeat(8), usage: missing }]} sort="cost" direction="desc" onSort={() => undefined} />);
		expect(table).toContain("aria-sort=\"descending\"");
		expect(table).toContain("historical-provider");
		expect(table).toContain("—");
		const trend = render(<StatisticsTrend days={[day("2026-10-14"), day("2026-10-15")]} />);
		expect(trend).toContain("tabindex=\"0\"");
		expect(trend).toContain("aria-pressed=\"true\"");
		const calendar = render(<StatisticsCalendar calendar={{ year: 2026, from: 0, to: now, days: [day("2026-10-14"), day("2026-10-15")], activeDays: 2, currentStreak: 2, longestStreak: 2, peakTokens: 430 }} generatedAt={now} timeZone="Asia/Shanghai" years={[2026]} onYear={() => undefined} />);
		expect(calendar).toContain("2026-10-15");
		expect(calendar).toContain("aria-live=\"polite\"");
		expect(calendar).toContain("data-level=\"4\"");
	});
});

function call(): StatisticsCallRow {
	return { id: "response-1", createdAt: now, sessionId: "session", sessionName: "Test session", workspaceId: "workspace", workspaceName: "Test workspace",
		runId: "run", providerId: "openai-chatgpt", modelId: "test-model", kind: "assistant", cache: { status: "reported", inputTokens: 1000, cachedTokens: 900, hitRate: .9 } };
}
