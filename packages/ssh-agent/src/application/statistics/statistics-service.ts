import { addStatisticsUsage, emptyStatisticsUsage, type StatisticsDay, type StatisticsFilter,
	type StatisticsCallPage, type StatisticsCallsResult, type StatisticsMeta, type StatisticsModelResult, type StatisticsOptions, type StatisticsOverview,
	type StatisticsRecordsResult, type StatisticsRunPage, type StatisticsRunsResult,
	type StatisticsWorkspaceResult } from "../../domain/statistics.ts";
import type { StatisticsQuery, StatisticsUsageGroup, StatisticsRunGroup } from "./statistics-query.ts";
import { shiftStatisticsDay, statisticsDates, statisticsDay, statisticsMidnight } from "./statistics-time.ts";

export type StatisticsSort = "tokens" | "cost" | "calls" | "runs";

export class StatisticsService {
	private readonly query: StatisticsQuery;
	private readonly now: () => number;

	constructor(query: StatisticsQuery, now: () => number = Date.now) {
		this.query = query;
		this.now = now;
	}

	options(): StatisticsOptions { return this.query.options(); }

	overview(filter: StatisticsFilter, year: number): StatisticsOverview {
		const generatedAt = this.now();
		const usageDays = this.query.usageByDay(filter);
		const runDays = this.query.runsByDay(filter);
		const usage = emptyStatisticsUsage();
		for (const day of usageDays) addStatisticsUsage(usage, day.usage);
		const firstRecorded = [...usageDays.map((row) => row.key), ...runDays.map((row) => row.key)].sort()[0];
		const firstDay = filter.from === 0 ? firstRecorded ?? statisticsDay(generatedAt, filter.timeZone) : statisticsDay(filter.from, filter.timeZone);
		const trend = days(firstDay, statisticsDay(filter.to - 1, filter.timeZone), usageDays, runDays);
		const from = statisticsMidnight(`${year}-01-01`, filter.timeZone);
		const to = statisticsMidnight(`${year + 1}-01-01`, filter.timeZone);
		const calendarFilter = { ...filter, from, to: Math.min(to, generatedAt + 1) };
		const calendarDays = days(`${year}-01-01`, `${year}-12-31`, this.query.usageByDay(calendarFilter), this.query.runsByDay(calendarFilter, true));
		const activeDates = new Set(this.query.activeDates({ ...filter, from: 0, to: generatedAt + 1 }));
		let streak = 0, longestStreak = 0;
		for (const day of calendarDays) {
			streak = day.active ? streak + 1 : 0;
			longestStreak = Math.max(longestStreak, streak);
		}
		let currentStreak = 0;
		let date = statisticsDay(generatedAt, filter.timeZone);
		if (!activeDates.has(date)) date = shiftStatisticsDay(date, -1);
		while (activeDates.has(date)) { currentStreak++; date = shiftStatisticsDay(date, -1); }
		return { ...this.meta(filter, generatedAt), usage, runs: this.query.runSummary(filter), trend,
			calendar: { year, from, to, days: calendarDays, activeDays: calendarDays.filter((day) => day.active).length,
				currentStreak, longestStreak, peakTokens: Math.max(0, ...calendarDays.map((day) => day.usage.totalTokens)) } };
	}

	models(filter: StatisticsFilter, sort: StatisticsSort = "cost", ascending = false): StatisticsModelResult {
		const rows = this.query.models(filter);
		const value = (row: typeof rows[number]) => sort === "cost" ? row.usage.cost.total : sort === "calls" ? row.usage.calls : row.usage.totalTokens;
		rows.sort((a, b) => (value(a) - value(b)) * (ascending ? 1 : -1) || a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
		return { ...this.meta(filter), rows };
	}

	runs(filter: StatisticsFilter): StatisticsRunsResult { return { ...this.meta(filter), summary: this.query.runSummary(filter) }; }

	records(filter: StatisticsFilter, page: StatisticsRunPage): StatisticsRecordsResult {
		const rows = this.query.runRecords(filter, page);
		const more = rows.length > page.limit;
		if (more) rows.pop();
		const last = rows.at(-1);
		const nextCursor = more && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url") : null;
		return { ...this.meta(filter), rows, nextCursor };
	}

	calls(filter: StatisticsFilter, page: StatisticsCallPage): StatisticsCallsResult {
		const rows = this.query.callRecords(filter, page);
		const more = rows.length > page.limit;
		if (more) rows.pop();
		const last = rows.at(-1);
		const nextCursor = more && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url") : null;
		return { ...this.meta(filter), rows, nextCursor };
	}

	workspaces(filter: StatisticsFilter, sort: StatisticsSort = "tokens", ascending = false): StatisticsWorkspaceResult {
		const usage = new Map(this.query.usageByWorkspace(filter).map((row) => [row.key, row.usage]));
		const runs = new Map(this.query.runsByWorkspace(filter).map((row) => [row.key, row.total]));
		const activeDays = new Map<string, number>();
		for (const row of this.query.activeWorkspaceDays(filter)) activeDays.set(row.workspaceId, (activeDays.get(row.workspaceId) ?? 0) + 1);
		const rows = this.query.options().workspaces.filter((row) => (!filter.workspaceId || row.id === filter.workspaceId) && (usage.has(row.id) || runs.has(row.id) || activeDays.has(row.id)))
			.map((row) => ({ workspaceId: row.id, name: row.name, hostname: row.hostname, runs: runs.get(row.id) ?? 0,
				activeDays: activeDays.get(row.id) ?? 0, usage: usage.get(row.id) ?? emptyStatisticsUsage() }));
		const value = (row: typeof rows[number]) => sort === "cost" ? row.usage.cost.total : sort === "runs" ? row.runs : sort === "calls" ? row.usage.calls : row.usage.totalTokens;
		rows.sort((a, b) => (value(a) - value(b)) * (ascending ? 1 : -1) || a.workspaceId.localeCompare(b.workspaceId));
		return { ...this.meta(filter), rows };
	}

	private meta(filter: StatisticsFilter, generatedAt = this.now()): StatisticsMeta {
		return { generatedAt, range: { from: filter.from, to: filter.to, timeZone: filter.timeZone } };
	}
}

function days(first: string, last: string, usage: StatisticsUsageGroup[], runs: StatisticsRunGroup[]): StatisticsDay[] {
	const byDate = new Map(usage.map((row) => [row.key, row.usage]));
	const runDates = new Map(runs.map((row) => [row.key, row.total]));
	return statisticsDates(first, last).map((date) => ({ date, usage: byDate.get(date) ?? emptyStatisticsUsage(),
		runs: runDates.get(date) ?? 0, active: (byDate.get(date)?.calls ?? 0) > 0 || (runDates.get(date) ?? 0) > 0 }));
}
