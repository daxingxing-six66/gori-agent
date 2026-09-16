import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceHostTrustRepository } from "../../application/repositories/workspace-host-trust-repository.ts";
import type { WorkspaceId } from "../../domain/ids.ts";
import type { VerifiedHostKey } from "../../domain/workspace.ts";

interface WorkspaceHostTrustRow {
	algorithm: string;
	fingerprint: string;
	verified_at: number;
}

export class SqliteWorkspaceHostTrustRepository implements WorkspaceHostTrustRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async findByWorkspaceId(workspaceId: WorkspaceId): Promise<VerifiedHostKey | undefined> {
		const row = this.database
			.prepare("SELECT algorithm, fingerprint, verified_at FROM workspace_host_trusts WHERE workspace_id = ?")
			.get(workspaceId) as unknown as WorkspaceHostTrustRow | undefined;
		return row === undefined
			? undefined
			: { algorithm: row.algorithm, fingerprint: row.fingerprint, verifiedAt: row.verified_at };
	}

	async insertIfAbsent(workspaceId: WorkspaceId, hostKey: VerifiedHostKey): Promise<boolean> {
		const result = this.database
			.prepare(`INSERT INTO workspace_host_trusts (workspace_id, algorithm, fingerprint, verified_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(workspace_id) DO NOTHING`)
			.run(workspaceId, hostKey.algorithm, hostKey.fingerprint, hostKey.verifiedAt);
		return result.changes === 1;
	}
}
