import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { WorkspaceListFilter, WorkspaceRepository } from "../../application/repositories/workspace-repository.ts";
import type { WorkspaceId } from "../../domain/ids.ts";
import type { Workspace } from "../../domain/workspace.ts";
import { type WorkspaceRow, workspaceFromRow } from "./rows.ts";

const WORKSPACE_COLUMNS = `w.id, w.display_name, w.environment, w.hostname, w.port,
	host_trust.algorithm AS host_key_algorithm, host_trust.fingerprint AS host_key_fingerprint,
	host_trust.verified_at AS host_key_verified_at,
	active_credential.id AS active_credential_id, w.default_cwd, w.connect_timeout_ms,
	w.keepalive_interval_ms, w.keepalive_max_count, w.revision, w.created_at, w.updated_at`;
const WORKSPACE_FROM = `workspaces w
	JOIN credentials active_credential
		ON active_credential.workspace_id = w.id AND active_credential.is_active = 1
	LEFT JOIN workspace_host_trusts host_trust ON host_trust.workspace_id = w.id`;

export class SqliteWorkspaceRepository implements WorkspaceRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async findById(id: WorkspaceId): Promise<Workspace | undefined> {
		const row = this.database.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM ${WORKSPACE_FROM} WHERE w.id = ?`).get(id);
		return row === undefined ? undefined : workspaceFromRow(row as unknown as WorkspaceRow);
	}

	async list(filter: WorkspaceListFilter = {}): Promise<Workspace[]> {
		const conditions: string[] = [];
		const parameters: SQLInputValue[] = [];
		if (filter.environment !== undefined) {
			conditions.push("w.environment = ?");
			parameters.push(filter.environment);
		}
		if (filter.query !== undefined) {
			conditions.push("(w.display_name LIKE ? ESCAPE '\\' OR w.hostname LIKE ? ESCAPE '\\')");
			const query = `%${escapeLike(filter.query)}%`;
			parameters.push(query, query);
		}
		const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
		const rows = this.database
			.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM ${WORKSPACE_FROM}${where} ORDER BY w.display_name, w.id`)
			.all(...parameters);
		return rows.map((row) => workspaceFromRow(row as unknown as WorkspaceRow));
	}

	async insert(workspace: Workspace): Promise<void> {
		this.database
			.prepare(`INSERT INTO workspaces (
				id, display_name, environment, hostname, port, default_cwd, connect_timeout_ms,
				keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				workspace.id,
				workspace.displayName,
				workspace.environment,
				workspace.host.hostname,
				workspace.host.port,
				workspace.defaultCwd,
				workspace.connection.connectTimeoutMs,
				workspace.connection.keepaliveIntervalMs,
				workspace.connection.keepaliveMaxCount,
				workspace.revision,
				workspace.createdAt,
				workspace.updatedAt,
			);
	}

	async update(workspace: Workspace, expectedRevision: number): Promise<boolean> {
		const result = this.database
			.prepare("UPDATE workspaces SET display_name = ?, default_cwd = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
			.run(workspace.displayName, workspace.defaultCwd, workspace.revision, workspace.updatedAt, workspace.id, expectedRevision);
		return result.changes === 1;
	}

	async delete(id: WorkspaceId, expectedRevision: number): Promise<boolean> {
		return (
			this.database.prepare("DELETE FROM workspaces WHERE id = ? AND revision = ?").run(id, expectedRevision)
				.changes === 1
		);
	}
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
