import type { DatabaseSync } from "node:sqlite";
import type { DeploymentSessionRepository } from "../../application/repositories/deployment-session-repository.ts";
import { DeploymentError } from "../../domain/deployment.ts";
import type { DeploymentOutcome, DeploymentSession } from "../../domain/deployment-session.ts";
import type { ChatMessageProjection } from "../../domain/chat.ts";

export class SqliteDeploymentSessionRepository implements DeploymentSessionRepository {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) { this.database = database; }

	find(sessionId: string, id: string): DeploymentSession | undefined {
		return parse(this.database.prepare("SELECT * FROM deployment_sessions WHERE session_id = ? AND id = ?").get(sessionId, id));
	}

	active(sessionId: string): DeploymentSession | undefined {
		return parse(this.database.prepare("SELECT * FROM deployment_sessions WHERE session_id = ? AND outcome IS NULL").get(sessionId));
	}

	historyMessage(sessionId: string, id: string): ChatMessageProjection | undefined {
		const row = this.database.prepare(`SELECT id, sequence, message_json, created_at FROM chat_messages
			WHERE session_id = ? AND id = ? AND message_type = 'deployment'`).get(sessionId, `deployment:${id}`);
		if (!row) return undefined;
		let value: unknown;
		try { value = JSON.parse(String(row.message_json)); } catch { throw corrupt(); }
		if (!value || typeof value !== "object" || !("role" in value) || value.role !== "custom" ||
			!("customType" in value) || value.customType !== "deployment" || !("content" in value) || typeof value.content !== "string" ||
			!("timestamp" in value) || !Number.isSafeInteger(value.timestamp) || typeof row.id !== "string" ||
			!Number.isSafeInteger(row.sequence) || !Number.isSafeInteger(row.created_at)) throw corrupt();
		return { id: row.id, sequence: Number(row.sequence), message: value as ChatMessageProjection["message"], createdAt: Number(row.created_at) };
	}

	insert(deployment: DeploymentSession): void {
		this.database.prepare(`INSERT INTO deployment_sessions (id, session_id, workspace_id, title, created_at)
			VALUES (?, ?, ?, ?, ?)`).run(deployment.id, deployment.sessionId, deployment.workspaceId, deployment.title, deployment.createdAt);
	}

	finish(sessionId: string, id: string, outcome: DeploymentOutcome, reason: string | undefined, now: number): boolean {
		return this.database.prepare(`UPDATE deployment_sessions SET outcome = ?, reason = ?, finished_at = ?
			WHERE session_id = ? AND id = ? AND outcome IS NULL`).run(outcome, reason ?? null, now, sessionId, id).changes === 1;
	}

	recoverInterrupted(now: number): void {
		// DeploymentRun recovery has already conservatively settled orphaned processes.
		// A discussion without an execution plan can continue across a backend restart.
		this.database.prepare(`UPDATE deployment_sessions SET
			outcome = (SELECT status FROM deployment_runs WHERE id = deployment_sessions.id),
			reason = 'Backend restarted; inspect recorded effects before starting another deployment', finished_at = MAX(created_at, ?)
			WHERE outcome IS NULL AND id IN (SELECT id FROM deployment_runs WHERE status IN ('success', 'failed', 'cancelled'))`).run(now);
	}
}

function parse(value: unknown): DeploymentSession | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw corrupt();
	const row = value as Record<string, unknown>;
	if (![row.id, row.session_id, row.workspace_id, row.title].every((field) =>
		typeof field === "string" && field.length > 0 && field.length <= 200 && !/[\0-\x1f]/u.test(field)) ||
		!Number.isSafeInteger(row.created_at) || Number(row.created_at) < 0 ||
		(row.outcome !== null && row.outcome !== "success" && row.outcome !== "failed" && row.outcome !== "cancelled") ||
		(row.reason !== null && (typeof row.reason !== "string" || row.reason.length > 4000)) ||
		(row.outcome === null ? row.finished_at !== null : !Number.isSafeInteger(row.finished_at) || Number(row.finished_at) < Number(row.created_at))) throw corrupt();
	return {
		id: row.id as string, sessionId: row.session_id as string, workspaceId: row.workspace_id as string,
		title: row.title as string, createdAt: row.created_at as number,
		...(row.outcome === null ? {} : { outcome: row.outcome as DeploymentOutcome, finishedAt: row.finished_at as number }),
		...(row.reason === null ? {} : { reason: row.reason as string }),
	};
}

function corrupt(): DeploymentError {
	return new DeploymentError("deployment_data_corrupt", "Saved deployment session is invalid", 500);
}
