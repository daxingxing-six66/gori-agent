import type { StatisticsService, StatisticsSort } from "../application/statistics/statistics-service.ts";
import { shiftStatisticsDay, statisticsDay, statisticsMidnight } from "../application/statistics/statistics-time.ts";
import { ManagementError } from "../domain/errors.ts";
import type { StatisticsFilter, StatisticsRunPage, StatisticsRunStatus } from "../domain/statistics.ts";

export function handleStatisticsRoute(service: StatisticsService, request: Request, url: URL, segments: readonly string[]): Response | null {
	if (segments[1] !== "statistics") return null;
	if (request.method !== "GET") return Response.json({ error: { code: "method_not_allowed", message: "GET required" } }, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
	if (segments.length !== 3) return null;
	const endpoint = segments[2];
	if (endpoint === "options") return json(service.options());
	const filter = parseStatisticsFilter(url);
	const sort = choice(url, "sort", ["tokens", "cost", "calls", "runs"] as const, endpoint === "models" ? "cost" : "tokens");
	const ascending = choice(url, "direction", ["asc", "desc"] as const, "desc") === "asc";
	switch (endpoint) {
		case "overview": return json(service.overview(filter, integer(url, "year", Number(statisticsDay(Date.now(), filter.timeZone).slice(0, 4)), 1970, 2100)));
		case "models": return json(service.models(filter, sort as StatisticsSort, ascending));
		case "runs": return json(service.runs(filter));
		case "run-records": return json(service.records(filter, parsePage(url)));
		case "workspaces": return json(service.workspaces(filter, sort as StatisticsSort, ascending));
		default: return null;
	}
}

export function parseStatisticsFilter(url: URL, now = Date.now()): StatisticsFilter {
	const timeZone = url.searchParams.get("timeZone") ?? "Asia/Shanghai";
	try { new Intl.DateTimeFormat("en", { timeZone }).format(now); } catch { throw invalid("timeZone"); }
	const today = statisticsDay(now, timeZone);
	const from = integer(url, "from", statisticsMidnight(shiftStatisticsDay(today, -29), timeZone), 0, Date.UTC(2101, 0, 1));
	const to = integer(url, "to", now + 1, 1, Date.UTC(2101, 0, 1));
	if (from >= to) throw invalid("to");
	const filter: StatisticsFilter = { from, to, timeZone };
	for (const key of ["workspaceId", "providerId", "modelId"] as const) {
		const value = url.searchParams.get(key);
		if (value !== null) {
			if (!value.trim() || value.length > 512) throw invalid(key);
			filter[key] = value;
		}
	}
	if (filter.modelId && !filter.providerId) throw invalid("providerId");
	return filter;
}

function parsePage(url: URL): StatisticsRunPage {
	const page: StatisticsRunPage = { limit: integer(url, "limit", 25, 1, 100) };
	if (url.searchParams.has("status")) page.status = choice(url, "status", ["pending", "running", "completed", "failed", "cancelled"] as const, "completed") as StatisticsRunStatus;
	const cursor = url.searchParams.get("cursor");
	if (cursor !== null) {
		try {
			if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw invalid("cursor");
			const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
			if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) || value[0] < 0 || typeof value[1] !== "string" || !value[1] || value[1].length > 512) throw invalid("cursor");
			page.before = { createdAt: value[0] as number, id: value[1] };
		} catch { throw invalid("cursor"); }
	}
	return page;
}

function choice<const T extends readonly string[]>(url: URL, name: string, values: T, fallback: T[number]): T[number] {
	const value = url.searchParams.get(name) ?? fallback;
	if (!values.includes(value)) throw invalid(name);
	return value;
}

function integer(url: URL, name: string, fallback: number, min: number, max: number): number {
	const raw = url.searchParams.get(name);
	if (raw === null) return fallback;
	const value = Number(raw);
	if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw invalid(name);
	return value;
}

function invalid(field: string): ManagementError { return new ManagementError("validation_error", `Invalid statistics parameter: ${field}`, field); }
function json(value: unknown): Response { return Response.json(value, { headers: { "cache-control": "no-store" } }); }
