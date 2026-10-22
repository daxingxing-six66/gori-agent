import type {
	StatisticsCallPage, StatisticsCallRow, StatisticsFilter, StatisticsModelRow, StatisticsOptions, StatisticsRunPage,
	StatisticsRunRow, StatisticsRunSummary, StatisticsUsage,
} from "../../domain/statistics.ts";

export interface StatisticsUsageGroup {
	key: string;
	usage: StatisticsUsage;
}
export interface StatisticsRunGroup {
	key: string;
	total: number;
}
export interface StatisticsWorkspaceInfo { id: string; name: string; hostname: string }

/** The only data dependency of the statistics application service. */
export interface StatisticsQuery {
	options(): StatisticsOptions;
	usageByDay(filter: StatisticsFilter): StatisticsUsageGroup[];
	usageByWorkspace(filter: StatisticsFilter): StatisticsUsageGroup[];
	models(filter: StatisticsFilter): StatisticsModelRow[];
	runSummary(filter: StatisticsFilter): StatisticsRunSummary;
	runsByDay(filter: StatisticsFilter, activityOnly?: boolean): StatisticsRunGroup[];
	runsByWorkspace(filter: StatisticsFilter): StatisticsRunGroup[];
	activeWorkspaceDays(filter: StatisticsFilter): { workspaceId: string; date: string }[];
	activeDates(filter: StatisticsFilter): string[];
	runRecords(filter: StatisticsFilter, page: StatisticsRunPage): StatisticsRunRow[];
	callRecords(filter: StatisticsFilter, page: StatisticsCallPage): StatisticsCallRow[];
}
