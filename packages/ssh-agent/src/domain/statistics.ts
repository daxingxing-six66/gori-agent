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
export interface StatisticsCallCache {
	status: "reported" | "unreported" | "invalid";
	/** Provider-reported total input, including cached input; never an estimate. */
	inputTokens: number | null;
	cachedTokens: number | null;
	hitRate: number | null;
}
export interface StatisticsCallRow {
	id: string;
	createdAt: number;
	sessionId: string;
	sessionName: string;
	workspaceId: string;
	workspaceName: string;
	runId: string | null;
	providerId: string;
	modelId: string;
	kind: "assistant" | "compact" | "compact_summary";
	cache: StatisticsCallCache;
}
export interface StatisticsCallsResult extends StatisticsMeta {
	rows: StatisticsCallRow[];
	nextCursor: string | null;
}
export interface StatisticsCallPage {
	limit: number;
	before?: { createdAt: number; id: string };
}
export interface StatisticsRunPage {
	limit: number;
	status?: StatisticsRunStatus;
	before?: { createdAt: number; id: string };
}

/** Legacy normalized token fields cannot prove whether an API reported a zero. */
export function statisticsCallCache(details: unknown): StatisticsCallCache {
	const unavailable = (status: "unreported" | "invalid"): StatisticsCallCache =>
		({ status, inputTokens: null, cachedTokens: null, hitRate: null });
	if (details === undefined || details === null) return unavailable("unreported");
	if (typeof details !== "object" || Array.isArray(details)) return unavailable("invalid");
	const value = details as Record<string, unknown>;
	const { inputTokens, cachedTokens } = value;
	if (typeof inputTokens !== "number" || typeof cachedTokens !== "number" ||
		!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(cachedTokens) ||
		inputTokens < 0 || cachedTokens < 0 || cachedTokens > inputTokens) return unavailable("invalid");
	return { status: "reported", inputTokens, cachedTokens, hitRate: inputTokens === 0 ? null : cachedTokens / inputTokens };
}

export function emptyStatisticsUsage(): StatisticsUsage {
	return { calls: 0, usageSamples: 0, costSamples: 0, input: 0, output: 0, cacheRead: 0,
		cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addStatisticsUsage(target: StatisticsUsage, source: StatisticsUsage): void {
	for (const key of ["calls", "usageSamples", "costSamples", "input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		target[key] += source[key];
	}
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += source.cost[key];
}
