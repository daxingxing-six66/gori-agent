import type { DatabaseSync } from "node:sqlite";
import type { ChatMessageListCursor, ChatMessagePage, ChatMessageProjection } from "../../domain/chat.ts";

/** UI-only read model. Model context and compaction continue reading the original transcript. */
export class SqliteChatHistoryQuery {
	private readonly database: DatabaseSync;
	private readonly projectRows: (rows: readonly Record<string, unknown>[]) => ChatMessageProjection[];

	constructor(
		database: DatabaseSync,
		projectRows: (rows: readonly Record<string, unknown>[]) => ChatMessageProjection[],
	) {
		this.database = database;
		this.projectRows = projectRows;
	}
	list(sessionId: string, cursor: ChatMessageListCursor, limit: number): ChatMessagePage {
		const forward = cursor.direction === "after";
		const filter = cursor.direction === "latest" ? "" : `WHERE sequence ${forward ? ">" : "<"} ?`;
		const rows = this.database.prepare(`${HISTORY_ENTRIES}, page_sequences AS (
			SELECT DISTINCT sequence FROM entries ${filter} ORDER BY sequence ${forward ? "ASC" : "DESC"} LIMIT ?
		) SELECT entries.* FROM entries JOIN page_sequences USING (sequence)
			ORDER BY sequence, history_order, created_at, id`).all(
			sessionId, sessionId, sessionId, ...(cursor.direction === "latest" ? [] : [cursor.sequence]), limit + 1,
		);
		// A sequence and its attached legacy cards form one cursor group. Never split a group.
		const sequences = [...new Set(rows.map((row) => Number(row.sequence)))];
		const hasMore = sequences.length > limit;
		const kept = new Set(hasMore ? forward ? sequences.slice(0, limit) : sequences.slice(1) : sequences);
		const pageRows = rows.filter((row) => kept.has(Number(row.sequence)));
		const messages = this.projectRows(pageRows).map((message, index): ChatMessageProjection => {
			const row = pageRows[index]!;
			return Number(row.history_order) === 1 ? { ...message, historyOrder: 1 } : message;
		});
		return { messages,
			nextBeforeSequence: !forward && hasMore ? messages[0]?.sequence ?? null : null,
			nextSequence: forward && hasMore ? messages.at(-1)?.sequence ?? null : null };
	}
}

// Only identity, status and times are projected from deployment snapshots; no command or log payload.
const HISTORY_ENTRIES = `WITH
chat_rows AS (SELECT * FROM chat_messages WHERE session_id = ?),
formal AS (
	SELECT *, json_extract(message_json, '$.details.deploymentId') AS deployment_id,
		json_extract(message_json, '$.details.position') = 'legacy_finished' AS relocated
	FROM chat_rows WHERE message_type = 'deployment'
),
legacy_runs AS (
	SELECT r.id, r.status, r.created_at,
		json_extract(r.snapshot_json, '$.plan.module.name') AS title,
		COALESCE(json_extract(r.snapshot_json, '$.startedAt'), r.created_at) AS started_at,
		CASE WHEN r.status IN ('success', 'failed', 'cancelled') THEN json_extract(r.snapshot_json, '$.finishedAt') END AS finished_at
	FROM deployment_runs r WHERE r.session_id = ? AND NOT EXISTS (
		SELECT 1 FROM formal f WHERE f.deployment_id = r.id OR f.deployment_id = json_extract(r.snapshot_json, '$.discussionId')
	)
),
legacy_discussions AS (
	SELECT d.id, d.created_at, json_extract(d.snapshot_json, '$.module.name') AS title
	FROM deployment_discussions d WHERE d.session_id = ? AND d.status = 'discussing'
		AND NOT EXISTS (SELECT 1 FROM formal f WHERE f.deployment_id = d.id)
		AND NOT EXISTS (SELECT 1 FROM deployment_runs r WHERE r.session_id = d.session_id
			AND (r.id = d.id OR json_extract(r.snapshot_json, '$.discussionId') = d.id))
),
cards AS (
	SELECT 'deployment:' || id AS id, COALESCE(finished_at, created_at) AS at, finished_at IS NOT NULL AS finished,
		json_object('role', 'custom', 'customType', 'deployment', 'display', json('true'), 'content', title,
			'timestamp', COALESCE(finished_at, created_at), 'details', json_object('deploymentId', id, 'title', title,
				'status', status, 'startedAt', started_at, 'finishedAt', finished_at,
				'outcome', CASE WHEN finished_at IS NOT NULL THEN status END, 'position', 'history')) AS message_json
	FROM legacy_runs
	UNION ALL
	SELECT 'deployment:' || id, created_at, 0,
		json_object('role', 'custom', 'customType', 'deployment', 'display', json('true'), 'content', title,
			'timestamp', created_at, 'details', json_object('deploymentId', id, 'title', title, 'status', 'discussing',
				'startedAt', created_at, 'position', 'history')) FROM legacy_discussions
	UNION ALL
	SELECT id, json_extract(message_json, '$.details.finishedAt'), 1,
		json_set(message_json, '$.details.position', 'history', '$.timestamp', json_extract(message_json, '$.details.finishedAt')) FROM formal WHERE relocated = 1
),
entries AS (
	SELECT c.id, c.sequence, c.run_id,
		CASE WHEN c.message_type = 'deployment' THEN json_set(c.message_json, '$.details.status', COALESCE(
			(SELECT r.status FROM deployment_runs r WHERE r.session_id = c.session_id
				AND (r.id = json_extract(c.message_json, '$.details.deploymentId')
					OR json_extract(r.snapshot_json, '$.discussionId') = json_extract(c.message_json, '$.details.deploymentId')) LIMIT 1),
			'discussing')) ELSE c.message_json END AS message_json,
		c.created_at, 0 AS history_order FROM chat_rows c
		WHERE NOT EXISTS (SELECT 1 FROM formal f WHERE f.id = c.id AND f.relocated = 1)
	UNION ALL
	SELECT c.id, COALESCE((SELECT MAX(m.sequence) FROM chat_rows m WHERE m.message_type <> 'deployment'
		AND (m.created_at < c.at OR (c.finished = 1 AND m.created_at = c.at))), 0),
		NULL, c.message_json, c.at, 1 FROM cards c
)`;
