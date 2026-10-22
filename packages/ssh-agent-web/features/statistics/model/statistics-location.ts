export const statisticsTabs = ["overview", "models", "calls", "runs", "workspaces"] as const;
export type StatisticsTab = typeof statisticsTabs[number];
export type StatisticsRange = "today" | "7d" | "30d" | "all" | "custom";
export interface StatisticsLocation {
	tab: StatisticsTab;
	range: StatisticsRange;
	start: string;
	end: string;
	workspaceId: string;
	providerId: string;
	model: string;
	timeZone: string;
	year: number;
	status: string;
	cursor: string;
	modelSort: string;
	workspaceSort: string;
	direction: string;
}

export function localDay(timestamp: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
	const get = (key: string) => parts.find((part) => part.type === key)?.value;
	return `${get("year")}-${get("month")}-${get("day")}`;
}
export function shiftDay(date: string, days: number): string {
	const value = new Date(`${date}T12:00:00Z`);
	value.setUTCDate(value.getUTCDate() + days);
	return value.toISOString().slice(0, 10);
}
function midnight(date: string, timeZone: string): number {
	const target = Date.parse(`${date}T00:00:00Z`);
	let value = target;
	const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
	for (let i = 0; i < 4; i++) {
		const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
		const difference = target - Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
		if (difference === 0) return value;
		value += difference;
	}
	let low = target - 36 * 3600_000, high = target + 36 * 3600_000;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (localDay(middle, timeZone) < date) low = middle + 1; else high = middle;
	}
	return low;
}
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const select = <T extends string>(value: string | null, choices: readonly T[], fallback: T): T => choices.includes(value as T) ? value as T : fallback;

export function parseStatisticsLocation(params: URLSearchParams, browserTimeZone: string, now: number): StatisticsLocation {
	let timeZone = params.get("timeZone") ?? browserTimeZone;
	try { localDay(now, timeZone); } catch { timeZone = "Asia/Shanghai"; }
	const today = localDay(now, timeZone);
	const currentYear = Number(today.slice(0, 4));
	const year = Number(params.get("year") ?? currentYear);
	const rawModel = params.get("model") ?? "";
	let model = "";
	let providerId = params.get("providerId") ?? "";
	if (!providerId.trim() || providerId.length > 512) providerId = "";
	try {
		const pair: unknown = JSON.parse(rawModel);
		if (Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string" && part.trim().length > 0 && part.length <= 512)) {
			// Existing shared links encoded the provider only inside the model pair.
			if (!params.has("providerId")) providerId = pair[0] as string;
			if (pair[0] === providerId) model = JSON.stringify(pair);
		}
	} catch { /* All models within the selected provider. */ }
	return {
		tab: select(params.get("tab"), statisticsTabs, "overview"),
		range: select(params.get("range"), ["today", "7d", "30d", "all", "custom"] as const, "30d"),
		start: params.get("start") ?? shiftDay(today, -29), end: params.get("end") ?? today,
		workspaceId: params.get("workspaceId") ?? "", providerId, model, timeZone,
		year: Number.isInteger(year) && year >= 1970 && year <= 2100 ? year : currentYear,
		status: select(params.get("status"), ["", "pending", "running", "completed", "failed", "cancelled"], ""),
		cursor: params.get("cursor") ?? "", modelSort: select(params.get("modelSort"), ["cost", "tokens", "calls"], "cost"),
		workspaceSort: select(params.get("workspaceSort"), ["tokens", "cost", "runs", "calls"], "tokens"),
		direction: select(params.get("direction"), ["asc", "desc"], "desc"),
	};
}

export function statisticsParams(location: StatisticsLocation, now: number): URLSearchParams | null {
	const today = localDay(now, location.timeZone);
	const start = location.range === "custom" ? location.start : shiftDay(today, location.range === "7d" ? -6 : location.range === "today" ? 0 : -29);
	const end = location.range === "custom" ? location.end : today;
	if (!validDate(start) || !validDate(end) || start > end || start < "1970-01-01" || end > "2100-12-31") return null;
	const params = new URLSearchParams({ from: String(location.range === "all" ? 0 : midnight(start, location.timeZone)),
		to: String(midnight(shiftDay(end, 1), location.timeZone)), timeZone: location.timeZone, year: String(location.year) });
	if (location.workspaceId) params.set("workspaceId", location.workspaceId);
	if (location.providerId) params.set("providerId", location.providerId);
	if (location.model && location.providerId) {
		const [providerId, modelId] = JSON.parse(location.model) as [string, string];
		if (providerId === location.providerId) params.set("modelId", modelId);
	}
	return params;
}
