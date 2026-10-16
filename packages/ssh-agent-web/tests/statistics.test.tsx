import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStatistics, isStatisticsResponse } from "../features/statistics/api/statistics-api";
import { groupTrendDays, StatisticsTrend } from "../features/statistics/components/statistics-trend";
import { StatisticsCalendar } from "../features/statistics/components/statistics-calendar";
import { StatisticsModelsTable } from "../features/statistics/components/statistics-models";
import { parseStatisticsLocation, statisticsParams } from "../features/statistics/model/statistics-location";
import type { StatisticsDay, StatisticsUsage } from "../features/statistics/model/statistics";
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
		expect(restored).toMatchObject({ tab: "models", range: "7d", workspaceId: "server / one", year: 2024, modelSort: "tokens", direction: "asc" });
		const query = statisticsParams(restored, now)!;
		expect(query.get("providerId")).toBe("provider / a");
		expect(query.get("modelId")).toBe("same-name");
		expect(query.get("from")).toBe(String(Date.parse("2026-10-08T16:00:00Z")));
		expect(query.get("to")).toBe(String(Date.parse("2026-10-15T16:00:00Z")));
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
