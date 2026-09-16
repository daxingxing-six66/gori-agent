import type { DatabaseSync } from "node:sqlite";
import type { GuardRepository } from "../../application/repositories/guard-repository.ts";
import type { Guard } from "../../domain/guard.ts";
import type { GuardId, WorkspaceId } from "../../domain/ids.ts";
import { type GuardRow, guardFromRow } from "./rows.ts";

const GUARD_COLUMNS = "id, workspace_id, enabled, rules_json, revision, created_at, updated_at";

export class SqliteGuardRepository implements GuardRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async findById(id: GuardId): Promise<Guard | undefined> {
		const row = this.database.prepare(`SELECT ${GUARD_COLUMNS} FROM guards WHERE id = ?`).get(id);
		return row === undefined ? undefined : guardFromRow(row as unknown as GuardRow);
	}

	async findByWorkspaceId(workspaceId: WorkspaceId): Promise<Guard | undefined> {
		const row = this.database.prepare(`SELECT ${GUARD_COLUMNS} FROM guards WHERE workspace_id = ?`).get(workspaceId);
		return row === undefined ? undefined : guardFromRow(row as unknown as GuardRow);
	}

	async insert(guard: Guard): Promise<void> {
		this.database
			.prepare(`INSERT INTO guards (
				id, workspace_id, enabled, rules_json, revision, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(
				guard.id,
				guard.workspaceId,
				guard.enabled ? 1 : 0,
				JSON.stringify(guard.rules),
				guard.revision,
				guard.createdAt,
				guard.updatedAt,
			);
	}

	async update(guard: Guard, expectedRevision: number): Promise<boolean> {
		const result = this.database
			.prepare(`UPDATE guards SET enabled = ?, rules_json = ?, revision = ?, updated_at = ?
				WHERE id = ? AND revision = ?`)
			.run(
				guard.enabled ? 1 : 0,
				JSON.stringify(guard.rules),
				guard.revision,
				guard.updatedAt,
				guard.id,
				expectedRevision,
			);
		return result.changes === 1;
	}

	async deleteByWorkspaceId(workspaceId: WorkspaceId): Promise<void> {
		this.database.prepare("DELETE FROM guards WHERE workspace_id = ?").run(workspaceId);
	}
}
