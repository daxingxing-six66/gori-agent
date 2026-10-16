/** Read-only statistics contracts; deliberately independent of runtime entities. */
export type StatisticsRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export interface StatisticsFilter {
	from: number;
	to: number;
	timeZone: string;
	workspaceId?: string;
	providerId?: string;
	modelId?: string;
}
export interface StatisticsCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}
export interface StatisticsUsage {
	calls: number;
	usageSamples: number;
	costSamples: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: StatisticsCost;
}
export interface StatisticsRunSummary {
	total: number;
	pending: number;
	running: number;
	completed: number;
	failed: number;
	cancelled: number;
	completionRate: number | null;
	averageDurationMs: number | null;
	longestDurationMs: number | null;
}
export interface StatisticsMeta {
	generatedAt: number;
	range: { from: number; to: number; timeZone: string };
}
export interface StatisticsDay {
	date: string;
	usage: StatisticsUsage;
	runs: number;
	active: boolean;
}
export interface StatisticsOverview extends StatisticsMeta {
	usage: StatisticsUsage;
	runs: StatisticsRunSummary;
	trend: StatisticsDay[];
	calendar: {
		year: number;
		from: number;
		to: number;
		days: StatisticsDay[];
		activeDays: number;
		currentStreak: number;
		longestStreak: number;
		peakTokens: number;
	};
}
export interface StatisticsModelRow {
	providerId: string;
	modelId: string;
	usage: StatisticsUsage;
}
export interface StatisticsWorkspaceRow {
	workspaceId: string;
	name: string;
	hostname: string;
	runs: number;
	activeDays: number;
	usage: StatisticsUsage;
}
export interface StatisticsRunRow {
	id: string;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	sessionId: string;
	sessionName: string;
	workspaceId: string;
	workspaceName: string;
	providerId: string;
	modelId: string;
	status: StatisticsRunStatus;
	durationMs: number | null;
	failure: { code: string; message: string } | null;
	usage: StatisticsUsage;
}
export interface StatisticsOptions {
	workspaces: { id: string; name: string; hostname: string }[];
	models: { providerId: string; modelId: string }[];
	earliestAt: number | null;
}
export interface StatisticsModelResult extends StatisticsMeta { rows: StatisticsModelRow[] }
export interface StatisticsWorkspaceResult extends StatisticsMeta { rows: StatisticsWorkspaceRow[] }
export interface StatisticsRunsResult extends StatisticsMeta { summary: StatisticsRunSummary }
export interface StatisticsRecordsResult extends StatisticsMeta {
	rows: StatisticsRunRow[];
	nextCursor: string | null;
}
export interface StatisticsRunPage {
	limit: number;
	status?: StatisticsRunStatus;
	before?: { createdAt: number; id: string };
}
