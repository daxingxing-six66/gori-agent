import type { DatabaseSync } from "node:sqlite";
import type { SessionRepository } from "../../application/repositories/session-repository.ts";
import type { SessionId, WorkspaceId } from "../../domain/ids.ts";
import type { AdvanceTerminalContextCursorInput, Session } from "../../domain/session.ts";
import { type SessionRow, sessionFromRow } from "./rows.ts";

const SESSION_COLUMNS = `id, workspace_id, display_name, work_dir, auto_audit, terminal_context_cursor,
	revision, created_at, updated_at`;

export class SqliteSessionRepository implements SessionRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async findById(id: SessionId): Promise<Session | undefined> {
		const row = this.database.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id);
		return row === undefined ? undefined : sessionFromRow(row as unknown as SessionRow);
	}

	async listByWorkspaceId(workspaceId: WorkspaceId): Promise<Session[]> {
		const rows = this.database
			.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace_id = ? ORDER BY created_at, id`)
			.all(workspaceId);
		return rows.map((row) => sessionFromRow(row as unknown as SessionRow));
	}

	async listAll(): Promise<Session[]> {
		const rows = this.database
			.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY workspace_id, created_at, id`)
			.all();
		return rows.map((row) => sessionFromRow(row as unknown as SessionRow));
	}

	async insert(session: Session): Promise<void> {
		this.database
			.prepare(`INSERT INTO sessions (
				id, workspace_id, display_name, work_dir, auto_audit, terminal_context_cursor, revision, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				session.id,
				session.workspaceId,
				session.displayName,
				session.workDir,
				session.autoAudit ? 1 : 0,
				session.terminalContextCursor,
				session.revision,
				session.createdAt,
				session.updatedAt,
			);
	}

	async update(session: Session, expectedRevision: number): Promise<boolean> {
		const result = this.database
			.prepare(
				"UPDATE sessions SET display_name = ?, work_dir = ?, auto_audit = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?",
			)
			.run(
				session.displayName,
				session.workDir,
				session.autoAudit ? 1 : 0,
				session.revision,
				session.updatedAt,
				session.id,
				expectedRevision,
			);
		return result.changes === 1;
	}

	async delete(id: SessionId, expectedRevision: number): Promise<boolean> {
		return (
			this.database.prepare("DELETE FROM sessions WHERE id = ? AND revision = ?").run(id, expectedRevision)
				.changes === 1
		);
	}

	async countByWorkspaceId(workspaceId: WorkspaceId): Promise<number> {
		const row = this.database
			.prepare("SELECT COUNT(*) AS count FROM sessions WHERE workspace_id = ?")
			.get(workspaceId);
		return Number(row?.count ?? 0);
	}

	async advanceTerminalContextCursor(input: AdvanceTerminalContextCursorInput): Promise<boolean> {
		const result = this.database
			.prepare(`UPDATE sessions SET terminal_context_cursor = ?
				WHERE id = ? AND terminal_context_cursor = ? AND ? >= terminal_context_cursor`)
			.run(input.toSequence, input.id, input.fromSequence, input.toSequence);
		return result.changes === 1;
	}
}
