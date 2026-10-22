import { apiRequest } from "@/shared/api/client";
import type { StatisticsCallsResult, StatisticsModelResult, StatisticsOptions, StatisticsOverview, StatisticsRecordsResult,
	StatisticsRunsResult, StatisticsWorkspaceResult } from "../model/statistics";

export interface StatisticsResponses {
	options: StatisticsOptions;
	overview: StatisticsOverview;
	models: StatisticsModelResult;
	runs: StatisticsRunsResult;
	"run-records": StatisticsRecordsResult;
	"call-records": StatisticsCallsResult;
	workspaces: StatisticsWorkspaceResult;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nullableNumber = (value: unknown) => value === null || number(value);
const string = (value: unknown): value is string => typeof value === "string";
const date = (value: unknown) => string(value) && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const list = (value: unknown, test: (row: unknown) => boolean) => Array.isArray(value) && value.every(test);
const numericFields = (value: unknown, fields: readonly string[]) => object(value) && fields.every((key) => number(value[key]));

function usage(value: unknown): boolean {
	return object(value) && numericFields(value, ["calls", "usageSamples", "costSamples", "input", "output", "cacheRead", "cacheWrite", "totalTokens"])
		&& numericFields(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])
		&& Number(value.usageSamples) <= Number(value.calls) && Number(value.costSamples) <= Number(value.calls);
}
function meta(value: ObjectValue): boolean {
	return number(value.generatedAt) && object(value.range) && number(value.range.from) && number(value.range.to)
		&& value.range.from < value.range.to && string(value.range.timeZone);
}
function summary(value: unknown): boolean {
	return object(value) && numericFields(value, ["total", "pending", "running", "completed", "failed", "cancelled"])
		&& nullableNumber(value.completionRate) && (value.completionRate === null || Number(value.completionRate) <= 1)
		&& nullableNumber(value.averageDurationMs) && nullableNumber(value.longestDurationMs);
}
function day(value: unknown): boolean {
	return object(value) && date(value.date) && usage(value.usage) && number(value.runs) && typeof value.active === "boolean";
}
function run(value: unknown): boolean {
	return object(value) && ["id", "sessionId", "sessionName", "workspaceId", "workspaceName", "providerId", "modelId"].every((key) => string(value[key]))
		&& number(value.createdAt) && nullableNumber(value.startedAt) && nullableNumber(value.finishedAt) && nullableNumber(value.durationMs)
		&& string(value.status) && ["pending", "running", "completed", "failed", "cancelled"].includes(value.status)
		&& usage(value.usage) && (value.failure === null || (object(value.failure) && string(value.failure.code) && string(value.failure.message)));
}

function call(value: unknown): boolean {
	if (!object(value) || !["id", "sessionId", "sessionName", "workspaceId", "workspaceName", "providerId", "modelId"].every((key) => string(value[key]))
		|| !number(value.createdAt) || !(value.runId === null || string(value.runId)) || !string(value.kind) || !["assistant", "compact", "compact_summary"].includes(value.kind) || !object(value.cache)) return false;
	const cache = value.cache;
	if (value.kind === "compact_summary" && cache.status !== "unreported") return false;
	if (cache.status === "unreported" || cache.status === "invalid")
		return cache.inputTokens === null && cache.cachedTokens === null && cache.hitRate === null;
	if (cache.status !== "reported" || !number(cache.inputTokens) || !Number.isSafeInteger(cache.inputTokens)
		|| !number(cache.cachedTokens) || !Number.isSafeInteger(cache.cachedTokens) || cache.cachedTokens > cache.inputTokens) return false;
	return cache.inputTokens === 0 ? cache.hitRate === null
		: number(cache.hitRate) && cache.hitRate === cache.cachedTokens / cache.inputTokens;
}

export function isStatisticsResponse(endpoint: keyof StatisticsResponses, value: unknown): boolean {
	if (!object(value)) return false;
	if (endpoint === "options") return nullableNumber(value.earliestAt)
		&& list(value.workspaces, (row) => object(row) && string(row.id) && string(row.name) && string(row.hostname))
		&& list(value.models, (row) => object(row) && string(row.providerId) && string(row.modelId));
	if (!meta(value)) return false;
	switch (endpoint) {
		case "overview": return usage(value.usage) && summary(value.runs) && list(value.trend, day)
			&& object(value.calendar) && numericFields(value.calendar, ["year", "from", "to", "activeDays", "currentStreak", "longestStreak", "peakTokens"])
			&& list(value.calendar.days, day);
		case "models": return list(value.rows, (row) => object(row) && string(row.providerId) && string(row.modelId) && usage(row.usage));
		case "runs": return summary(value.summary);
		case "run-records": return list(value.rows, run) && (value.nextCursor === null || string(value.nextCursor));
		case "call-records": return list(value.rows, call) && (value.nextCursor === null || string(value.nextCursor));
		case "workspaces": return list(value.rows, (row) => object(row) && string(row.workspaceId) && string(row.name) && string(row.hostname)
			&& number(row.runs) && number(row.activeDays) && usage(row.usage));
	}
}

export async function fetchStatistics<E extends keyof StatisticsResponses>(endpoint: E, params: URLSearchParams, signal: AbortSignal): Promise<StatisticsResponses[E]> {
	const value = await apiRequest<unknown>(`/api/statistics/${endpoint}?${params}`, { signal });
	if (!isStatisticsResponse(endpoint, value)) throw new Error("statistics_invalid_response");
	return value as StatisticsResponses[E];
}
