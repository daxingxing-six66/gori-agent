import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { StatisticsQuery, StatisticsUsageGroup, StatisticsRunGroup } from "../../application/statistics/statistics-query.ts";
import { statisticsDay } from "../../application/statistics/statistics-time.ts";
import { emptyStatisticsUsage, type StatisticsFilter, type StatisticsModelRow, type StatisticsOptions,
	type StatisticsRunPage, type StatisticsRunRow, type StatisticsRunStatus, type StatisticsRunSummary,
	type StatisticsUsage } from "../../domain/statistics.ts";

type Row = Record<string, SQLOutputValue>;
type Sql = { text: string; values: SQLInputValue[] };
const tokenKeys = ["input", "output", "cacheRead", "cacheWrite"] as const;
const costKeys = [...tokenKeys, "total"] as const;
const safeMessage = "CASE WHEN json_valid(m.message_json) THEN m.message_json ELSE '{}' END";
const messageProvider = `COALESCE(m.provider, json_extract(${safeMessage}, '$.provider'), 'unknown')`;
const messageModel = `COALESCE(json_extract(${safeMessage}, '$.model'), 'unknown')`;

/** Owns all knowledge of the existing schema. No runtime services or repositories are used. */
export class SqliteStatisticsQuery implements StatisticsQuery {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
		database.function("gori_statistics_day", { deterministic: true }, (timestamp, timeZone) =>
			statisticsDay(Number(timestamp), String(timeZone)));
	}

	options(): StatisticsOptions {
		const workspaces = this.database.prepare("SELECT id, display_name, hostname FROM workspaces ORDER BY display_name, id").all();
		const models = this.database.prepare(`SELECT DISTINCT providerId, modelId FROM (
			SELECT ${messageProvider} AS providerId, ${messageModel} AS modelId
			FROM chat_messages m WHERE m.message_type IN ('assistant', 'compact')
			UNION SELECT provider_id, model_id FROM chat_runs
		) ORDER BY providerId, modelId`).all();
		const earliest = this.database.prepare(`SELECT MIN(timestamp) AS earliest FROM (
			SELECT MIN(created_at) AS timestamp FROM chat_messages WHERE message_type IN ('assistant', 'compact')
			UNION ALL SELECT MIN(created_at) FROM chat_runs
		)`).get();
		return {
			workspaces: workspaces.map((row) => ({ id: String(row.id), name: String(row.display_name), hostname: String(row.hostname) })),
			models: models.map((row) => ({ providerId: String(row.providerId), modelId: String(row.modelId) })),
			earliestAt: earliest?.earliest == null ? null : Number(earliest.earliest),
		};
	}

	usageByDay(filter: StatisticsFilter): StatisticsUsageGroup[] {
		return this.usageGroups(filter, "gori_statistics_day(createdAt, ?)", [filter.timeZone]);
	}

	usageByWorkspace(filter: StatisticsFilter): StatisticsUsageGroup[] {
		return this.usageGroups(filter, "workspaceId");
	}

	models(filter: StatisticsFilter): StatisticsModelRow[] {
		const base = usageSource(filter);
		return this.database.prepare(`${base.text} SELECT providerId, modelId, ${usageSums()}
			FROM normalized GROUP BY providerId, modelId ORDER BY providerId, modelId`).all(...base.values)
			.map((row) => ({ providerId: String(row.providerId), modelId: String(row.modelId), usage: usageFromRow(row) }));
	}

	runSummary(filter: StatisticsFilter): StatisticsRunSummary {
		const where = runWhere(filter);
		const row = this.database.prepare(`SELECT COUNT(*) AS total,
			${(["pending", "running", "completed", "failed", "cancelled"] as const).map((status) =>
				`COALESCE(SUM(r.status = '${status}'), 0) AS ${status}`).join(",")},
			AVG(CASE WHEN r.status IN ('completed', 'failed', 'cancelled') AND r.finished_at >= r.started_at
				THEN r.finished_at - r.started_at END) AS averageDurationMs,
			MAX(CASE WHEN r.status IN ('completed', 'failed', 'cancelled') AND r.finished_at >= r.started_at
				THEN r.finished_at - r.started_at END) AS longestDurationMs
			FROM chat_runs r WHERE ${where.text}`).get(...where.values)!;
		const ended = Number(row.completed) + Number(row.failed) + Number(row.cancelled);
		return { total: Number(row.total), pending: Number(row.pending), running: Number(row.running),
			completed: Number(row.completed), failed: Number(row.failed), cancelled: Number(row.cancelled),
			completionRate: ended === 0 ? null : Number(row.completed) / ended,
			averageDurationMs: row.averageDurationMs === null ? null : Number(row.averageDurationMs),
			longestDurationMs: row.longestDurationMs === null ? null : Number(row.longestDurationMs) };
	}

	runsByDay(filter: StatisticsFilter, activityOnly = false): StatisticsRunGroup[] {
		const where = runWhere(filter, activityOnly ? "r.started_at" : "r.created_at");
		return this.database.prepare(`SELECT gori_statistics_day(${activityOnly ? "r.started_at" : "r.created_at"}, ?) AS key,
			COUNT(*) AS total FROM chat_runs r WHERE ${where.text} GROUP BY key ORDER BY key`)
			.all(filter.timeZone, ...where.values).map((row) => ({ key: String(row.key), total: Number(row.total) }));
	}

	runsByWorkspace(filter: StatisticsFilter): StatisticsRunGroup[] {
		const where = runWhere(filter);
		return this.database.prepare(`SELECT r.workspace_id AS key, COUNT(*) AS total FROM chat_runs r
			WHERE ${where.text} GROUP BY r.workspace_id`).all(...where.values)
			.map((row) => ({ key: String(row.key), total: Number(row.total) }));
	}

	activeWorkspaceDays(filter: StatisticsFilter): { workspaceId: string; date: string }[] {
		const usage = usageSource(filter);
		const runs = runWhere(filter, "r.started_at");
		return this.database.prepare(`${usage.text}
			SELECT workspaceId, gori_statistics_day(createdAt, ?) AS date FROM normalized
			UNION SELECT r.workspace_id, gori_statistics_day(r.started_at, ?) FROM chat_runs r WHERE ${runs.text}`)
			.all(...usage.values, filter.timeZone, filter.timeZone, ...runs.values)
			.map((row) => ({ workspaceId: String(row.workspaceId), date: String(row.date) }));
	}

	activeDates(filter: StatisticsFilter): string[] {
		const usage = usageSource(filter);
		const runs = runWhere(filter, "r.started_at");
		return this.database.prepare(`${usage.text}
			SELECT gori_statistics_day(createdAt, ?) AS date FROM normalized
			UNION SELECT gori_statistics_day(r.started_at, ?) FROM chat_runs r WHERE ${runs.text}
			ORDER BY date`).all(...usage.values, filter.timeZone, filter.timeZone, ...runs.values)
			.map((row) => String(row.date));
	}

	runRecords(filter: StatisticsFilter, page: StatisticsRunPage): StatisticsRunRow[] {
		const where = runWhere(filter);
		if (page.status) { where.text += " AND r.status = ?"; where.values.push(page.status); }
		if (page.before) {
			where.text += " AND (r.created_at, r.id) < (?, ?)";
			where.values.push(page.before.createdAt, page.before.id);
		}
		const rows = this.database.prepare(`SELECT r.id, r.created_at, r.started_at, r.finished_at,
			r.session_id, s.display_name AS session_name, r.workspace_id, w.display_name AS workspace_name,
			r.provider_id, r.model_id, r.status,
			json_extract(CASE WHEN json_valid(r.failure_json) THEN r.failure_json ELSE '{}' END, '$.code') AS failure_code,
			json_extract(CASE WHEN json_valid(r.failure_json) THEN r.failure_json ELSE '{}' END, '$.message') AS failure_message
			FROM chat_runs r JOIN sessions s ON s.id = r.session_id JOIN workspaces w ON w.id = r.workspace_id
			WHERE ${where.text} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
			.all(...where.values, page.limit + 1);
		if (rows.length === 0) return [];
		// Aggregate only the selected runs, across their complete lifetimes and all response models.
		const usageFilter = { from: 0, to: 8_640_000_000_000_000, timeZone: filter.timeZone };
		const usage = this.usageGroups(usageFilter, "runId", [], rows.map((row) => String(row.id)));
		const byRun = new Map(usage.map((group) => [group.key, group.usage]));
		return rows.map((row) => {
			const startedAt = row.started_at === null ? null : Number(row.started_at);
			const finishedAt = row.finished_at === null ? null : Number(row.finished_at);
			return { id: String(row.id), createdAt: Number(row.created_at), startedAt, finishedAt,
				sessionId: String(row.session_id), sessionName: String(row.session_name), workspaceId: String(row.workspace_id),
				workspaceName: String(row.workspace_name), providerId: String(row.provider_id), modelId: String(row.model_id),
				status: String(row.status) as StatisticsRunStatus,
				durationMs: startedAt !== null && finishedAt !== null && finishedAt >= startedAt ? finishedAt - startedAt : null,
				failure: typeof row.failure_code === "string" && typeof row.failure_message === "string"
					? { code: row.failure_code, message: row.failure_message } : null,
				usage: byRun.get(String(row.id)) ?? emptyStatisticsUsage() };
		});
	}

	private usageGroups(filter: StatisticsFilter, key: string, keyValues: SQLInputValue[] = [], runIds?: string[]): StatisticsUsageGroup[] {
		const source = usageSource(filter, runIds);
		return this.database.prepare(`${source.text} SELECT ${key} AS key, ${usageSums()}
			FROM normalized GROUP BY key ORDER BY key`).all(...source.values, ...keyValues)
			.map((row) => ({ key: String(row.key), usage: usageFromRow(row) }));
	}
}

function runWhere(filter: StatisticsFilter, timestamp = "r.created_at"): Sql {
	const result: Sql = { text: `${timestamp} >= ? AND ${timestamp} < ?`, values: [filter.from, filter.to] };
	for (const [field, column] of [["workspaceId", "workspace_id"], ["providerId", "provider_id"], ["modelId", "model_id"]] as const) {
		if (filter[field] !== undefined) { result.text += ` AND r.${column} = ?`; result.values.push(filter[field]); }
	}
	return result;
}

function validNumber(path: string, integer = false): string {
	const value = `json_extract(u, '$.${path}')`;
	return `(json_type(u, '$.${path}') IN (${integer ? "'integer'" : "'integer', 'real'"}) AND ${value} >= 0 AND ${value} <= ${integer ? Number.MAX_SAFE_INTEGER : 1e100})`;
}

function usageSource(filter: StatisticsFilter, runIds?: string[]): Sql {
	const values: SQLInputValue[] = [filter.from, filter.to];
	const conditions = ["m.message_type IN ('assistant', 'compact')", "m.created_at >= ?", "m.created_at < ?"];
	if (filter.workspaceId !== undefined) { conditions.push("s.workspace_id = ?"); values.push(filter.workspaceId); }
	if (filter.providerId !== undefined) { conditions.push(`${messageProvider} = ?`); values.push(filter.providerId); }
	if (filter.modelId !== undefined) { conditions.push(`${messageModel} = ?`); values.push(filter.modelId); }
	if (runIds) { conditions.push(`m.run_id IN (${runIds.map(() => "?").join(",")})`); values.push(...runIds); }
	const tokensValid = tokenKeys.map((key) => validNumber(key, true)).join(" AND ");
	return { values, text: `WITH source AS (
		SELECT m.run_id AS runId, s.workspace_id AS workspaceId, m.created_at AS createdAt,
			${messageProvider} AS providerId, ${messageModel} AS modelId,
			CASE WHEN json_valid(m.usage_json) THEN m.usage_json ELSE '{}' END AS u
		FROM chat_messages m JOIN sessions s ON s.id = m.session_id WHERE ${conditions.join(" AND ")}
	), normalized AS (
		SELECT runId, workspaceId, createdAt, providerId, modelId,
			CASE WHEN ${tokensValid} THEN 1 ELSE 0 END AS usageSamples,
			CASE WHEN ${validNumber("cost.total")} THEN 1 ELSE 0 END AS costSamples,
			${tokenKeys.map((key) => `CASE WHEN ${tokensValid} THEN json_extract(u, '$.${key}') ELSE 0 END AS ${key}`).join(",")},
			${costKeys.map((key) => `CASE WHEN ${validNumber(`cost.${key}`)} THEN json_extract(u, '$.cost.${key}') ELSE 0 END AS cost_${key}`).join(",")}
		FROM source
	)` };
}

function usageSums(): string {
	return `COUNT(*) AS calls, COALESCE(SUM(usageSamples), 0) AS usageSamples, COALESCE(SUM(costSamples), 0) AS costSamples,
		${tokenKeys.map((key) => `COALESCE(SUM(${key}), 0) AS ${key}`).join(",")},
		${costKeys.map((key) => `COALESCE(SUM(cost_${key}), 0) AS cost_${key}`).join(",")}`;
}

function usageFromRow(row: Row): StatisticsUsage {
	const input = Number(row.input), output = Number(row.output), cacheRead = Number(row.cacheRead), cacheWrite = Number(row.cacheWrite);
	return { calls: Number(row.calls), usageSamples: Number(row.usageSamples), costSamples: Number(row.costSamples),
		input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: Number(row.cost_input), output: Number(row.cost_output), cacheRead: Number(row.cost_cacheRead),
			cacheWrite: Number(row.cost_cacheWrite), total: Number(row.cost_total) } };
}
