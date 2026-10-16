import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { handleStatisticsRoute, parseStatisticsFilter } from "../src/api/statistics-routes.ts";
import { StatisticsService } from "../src/application/statistics/statistics-service.ts";
import { statisticsDay, statisticsMidnight } from "../src/application/statistics/statistics-time.ts";
import type { StatisticsFilter, StatisticsRunStatus } from "../src/domain/statistics.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteStatisticsQuery } from "../src/infrastructure/sqlite/sqlite-statistics-query.ts";
import { SqliteTransactionRunner } from "../src/infrastructure/sqlite/sqlite-transaction-runner.ts";

const now = Date.parse("2026-10-15T04:00:00Z");
const filter: StatisticsFilter = { from: Date.parse("2026-10-01T00:00:00Z"), to: now + 1, timeZone: "Asia/Shanghai" };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
	const database = new DatabaseSync(":memory:");
	databases.push(database);
	database.exec("PRAGMA foreign_keys = ON");
	applyMigrations(database);
	for (const id of ["a", "b"]) {
		database.prepare(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
			connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
			VALUES (?, ?, 'development', 'example.test', 22, '/tmp', 1000, 1000, 1, 1, ?, ?)`).run(id, `Workspace ${id}`, now, now);
		database.prepare(`INSERT INTO sessions (id, workspace_id, display_name, revision, created_at, updated_at)
			VALUES (?, ?, ?, 1, ?, ?)`).run(id, id, `Session ${id}`, now, now);
	}
	const query = new SqliteStatisticsQuery(database);
	const service = new StatisticsService(query, () => now);
	let sequence = 0;
	function run(id: string, status: StatisticsRunStatus = "completed", workspace = "a", timestamp = now - 60_000, provider = "one") {
		database.prepare(`INSERT INTO chat_runs (id, session_id, workspace_id, request_id, provider_id, model_id,
			thinking_level, status, created_at, started_at, finished_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'shared-model', 'off', ?, ?, ?, ?, ?)`)
			.run(id, workspace, workspace, id, provider, status, timestamp, status === "pending" ? null : timestamp,
				status === "pending" || status === "running" ? null : timestamp + 20_000, timestamp);
	}
	function message(id: string, options: { workspace?: string; runId?: string; provider?: string; model?: string;
		usage?: unknown; type?: string; timestamp?: number; nested?: unknown } = {}) {
		sequence++;
		database.prepare(`INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, provider,
			usage_json, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(id, options.workspace ?? "a", options.runId ?? null, sequence, options.type ?? "assistant", options.provider ?? "one",
				options.usage === undefined ? null : JSON.stringify(options.usage),
				JSON.stringify({ model: options.model ?? "shared-model", retainedTail: options.nested, content: "SECRET BODY" }), options.timestamp ?? now - 30_000);
	}
	return { database, query, service, run, message };
}

function usage(totalCost = 0.25) {
	return { input: 100, output: 20, cacheRead: 300, cacheWrite: 10, totalTokens: 430, reasoning: 5,
		cost: { input: totalCost / 4, output: totalCost / 4, cacheRead: totalCost / 4, cacheWrite: totalCost / 4, total: totalCost } };
}

describe("independent statistics queries", () => {
	it("counts top-level responses and manual compaction without duplicating retained history or runs", () => {
		const f = fixture();
		f.run("run-a"); f.run("run-b", "failed", "b", now - 60_000, "two");
		f.message("first", { runId: "run-a", usage: usage() });
		f.message("second", { runId: "run-a", usage: usage() });
		f.message("compact", { type: "compact", usage: usage(), nested: [{ role: "assistant", usage: usage(9000) }] });
		f.message("other", { workspace: "b", runId: "run-b", provider: "two", usage: usage(0) });
		f.message("tool", { type: "tool", usage: usage(999) });
		const result = f.service.overview(filter, 2026);
		expect(result.usage).toMatchObject({ calls: 4, usageSamples: 4, costSamples: 4, totalTokens: 1720, output: 80, cost: { total: 0.75 } });
		expect(result.runs).toMatchObject({ total: 2, completed: 1, failed: 1, completionRate: 0.5, averageDurationMs: 20_000 });
		expect(f.service.models(filter).rows).toHaveLength(2);
		expect(f.service.records(filter, { limit: 25 }).rows.find((row) => row.id === "run-a")?.usage.calls).toBe(2);
		expect(f.service.workspaces(filter).rows.reduce((sum, row) => sum + row.usage.totalTokens, 0)).toBe(1720);
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
	});

	it("distinguishes missing data, invalid usage and a reported zero cost", () => {
		const f = fixture();
		f.message("missing");
		f.message("zero", { usage: usage(0), provider: "zero" });
		f.message("invalid", { usage: { ...usage(), input: -1, cost: null }, provider: "invalid" });
		f.message("no-cost", { usage: { ...usage(), cost: undefined } });
		const result = f.service.overview(filter, 2026);
		expect(result.usage).toMatchObject({ calls: 4, usageSamples: 2, costSamples: 1, totalTokens: 860, cost: { total: 0 } });
		expect(f.service.models({ ...filter, providerId: "zero" }).rows[0].usage.costSamples).toBe(1);
		expect(f.service.models({ ...filter, providerId: "invalid" }).rows[0].usage.usageSamples).toBe(0);
	});

	it("keeps time, workspace and provider/model filters consistent with their own record attribution", () => {
		const f = fixture();
		f.run("old", "completed", "a", filter.from - 1000);
		f.message("new-response", { runId: "old", usage: usage(), provider: "two" });
		f.message("outside", { timestamp: filter.to, usage: usage() });
		f.message("different-workspace", { workspace: "b", usage: usage() });
		const result = f.service.overview({ ...filter, workspaceId: "a", providerId: "two", modelId: "shared-model" }, 2026);
		expect(result.usage.calls).toBe(1);
		expect(result.runs.total).toBe(0);
		expect(f.service.records({ ...filter, from: 0 }, { limit: 25 }).rows[0].usage.calls).toBe(1);
	});

	it("uses IANA day boundaries, leap years, and lets a streak end yesterday", () => {
		const f = fixture();
		for (const date of ["2026-10-12", "2026-10-13", "2026-10-14"]) f.message(date, { timestamp: statisticsMidnight(date, filter.timeZone), usage: usage() });
		f.run("never-started", "pending");
		const result = f.service.overview(filter, 2026);
		expect(result.calendar).toMatchObject({ activeDays: 3, currentStreak: 3, longestStreak: 3, peakTokens: 430 });
		expect(result.calendar.days.find((day) => day.date === "2026-10-15")?.active).toBe(false);
		expect(f.service.overview(filter, 2024).calendar.days).toHaveLength(366);
		expect(statisticsDay(Date.parse("2026-10-14T16:00:00Z"), "Asia/Shanghai")).toBe("2026-10-15");
		expect(statisticsMidnight("2026-03-09", "America/New_York") - statisticsMidnight("2026-03-08", "America/New_York")).toBe(23 * 3600_000);
		expect(statisticsMidnight("2018-11-04", "America/Sao_Paulo")).toBe(Date.parse("2018-11-04T03:00:00Z"));
	});

	it("paginates equal timestamps without duplicates and excludes unfinished runs from duration averages", () => {
		const f = fixture();
		for (const id of ["a", "b", "c"]) f.run(id);
		f.run("running", "running");
		const first = f.service.records(filter, { limit: 2 });
		expect(first.rows.map((row) => row.id)).toEqual(["running", "c"]);
		const [createdAt, id] = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()) as [number, string];
		const next = f.service.records(filter, { limit: 2, before: { createdAt, id } });
		expect(next.rows.map((row) => row.id)).toEqual(["b", "a"]);
		expect(next.nextCursor).toBeNull();
		expect(f.service.runs(filter).summary).toMatchObject({ total: 4, running: 1, completionRate: 1, averageDurationMs: 20_000 });
		expect(f.service.records(filter, { limit: 25, status: "failed" }).rows).toEqual([]);
	});

	it("queries do not write records, migrations are idempotent, and deletion follows existing cascade rules", () => {
		const f = fixture();
		f.run("run"); f.message("message", { runId: "run", usage: usage() });
		const before = f.database.prepare("SELECT total_changes() AS n").get()!.n;
		f.service.overview(filter, 2026); f.service.workspaces(filter); f.service.models(filter); f.service.records(filter, { limit: 25 });
		expect(f.database.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
		applyMigrations(f.database);
		expect(f.database.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
		expect(f.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'statistics_%'").all()).toHaveLength(5);
		f.database.prepare("DELETE FROM sessions WHERE id = 'a'").run();
		expect(f.service.overview(filter, 2026).usage.calls).toBe(0);
		expect(f.service.runs(filter).summary.total).toBe(0);
	});

	it("respects the shared SQLite transaction ownership guard", async () => {
		const f = fixture();
		const transactions = new SqliteTransactionRunner(f.database);
		let release: () => void = () => undefined;
		let entered: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const transaction = transactions.run(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
		await ready;
		expect(() => f.service.options()).toThrow("another transaction");
		release(); await transaction;
		expect(f.service.options().workspaces).toHaveLength(2);
	});

	it("serves the six read-only endpoints and validates unsafe parameters", async () => {
		const f = fixture();
		for (const endpoint of ["options", "overview", "models", "runs", "run-records", "workspaces"]) {
			const url = new URL(`http://test/api/statistics/${endpoint}?from=${filter.from}&to=${filter.to}&year=2026`);
			const response = handleStatisticsRoute(f.service, new Request(url), url, url.pathname.split("/").filter(Boolean))!;
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toBeTruthy();
		}
		for (const parameter of ["timeZone=invalid", "from=50&to=1", "from=-1", "modelId=missing", "from=NaN"]) {
			expect(() => parseStatisticsFilter(new URL(`http://test/?${parameter}`), now)).toThrow("Invalid statistics parameter");
		}
		for (const parameter of ["cursor=%25", "limit=101", "status=unknown", "sort=SQL", "year=999999"]) {
			const url = new URL(`http://test/api/statistics/${parameter.startsWith("year") ? "overview" : "run-records"}?${parameter}`);
			expect(() => handleStatisticsRoute(f.service, new Request(url), url, url.pathname.split("/").filter(Boolean))).toThrow();
		}
	});
});
