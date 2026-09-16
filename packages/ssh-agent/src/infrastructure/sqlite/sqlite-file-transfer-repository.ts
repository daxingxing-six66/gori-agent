import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FileTransferRepository } from "../../application/repositories/file-transfer-repository.ts";
import type { FileTransfer, TransferStatus } from "../../domain/file-transfer.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";

const COLUMNS = `id, workspace_id, direction, remote_path, file_name, total_bytes, bytes_transferred,
	overwrite, status, target_json, failure_json, created_at, started_at, finished_at, updated_at`;

interface FileTransferRow {
	id: string;
	workspace_id: string;
	direction: FileTransfer["direction"];
	remote_path: string;
	file_name: string;
	total_bytes: number;
	bytes_transferred: number;
	overwrite: number;
	status: TransferStatus;
	target_json: string;
	failure_json: string | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	updated_at: number;
}

export class SqliteFileTransferRepository implements FileTransferRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async insert(transfer: FileTransfer): Promise<void> {
		this.database
			.prepare(`INSERT INTO file_transfers (${COLUMNS}) VALUES (${new Array(15).fill("?").join(", ")})`)
			.run(...values(transfer));
	}

	async findById(id: string): Promise<FileTransfer | undefined> {
		const row = this.database.prepare(`SELECT ${COLUMNS} FROM file_transfers WHERE id = ?`).get(id);
		return row === undefined ? undefined : fromRow(row as unknown as FileTransferRow);
	}

	async listByWorkspaceId(workspaceId: string, limit: number): Promise<FileTransfer[]> {
		return this.database
			.prepare(
				`SELECT ${COLUMNS} FROM file_transfers WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
			.all(workspaceId, limit)
			.map((row) => fromRow(row as unknown as FileTransferRow));
	}

	async listByStatuses(statuses: readonly TransferStatus[]): Promise<FileTransfer[]> {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(", ");
		return this.database
			.prepare(`SELECT ${COLUMNS} FROM file_transfers WHERE status IN (${placeholders}) ORDER BY created_at`)
			.all(...statuses)
			.map((row) => fromRow(row as unknown as FileTransferRow));
	}

	async update(transfer: FileTransfer, expectedStatuses: readonly TransferStatus[]): Promise<boolean> {
		if (expectedStatuses.length === 0) return false;
		const placeholders = expectedStatuses.map(() => "?").join(", ");
		const result = this.database
			.prepare(`UPDATE file_transfers SET workspace_id = ?, direction = ?, remote_path = ?,
			file_name = ?, total_bytes = ?, bytes_transferred = ?, overwrite = ?, status = ?, target_json = ?, failure_json = ?,
			created_at = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
			.run(...values(transfer).slice(1), transfer.id, ...expectedStatuses);
		return result.changes === 1;
	}
}

function values(transfer: FileTransfer): SQLInputValue[] {
	return [
		transfer.id,
		transfer.workspaceId,
		transfer.direction,
		transfer.remotePath,
		transfer.fileName,
		transfer.totalBytes,
		transfer.bytesTransferred,
		transfer.overwrite ? 1 : 0,
		transfer.status,
		JSON.stringify(transfer.target),
		transfer.failure === undefined ? null : JSON.stringify(transfer.failure),
		transfer.createdAt,
		transfer.startedAt ?? null,
		transfer.finishedAt ?? null,
		transfer.updatedAt,
	];
}

function fromRow(row: FileTransferRow): FileTransfer {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		direction: row.direction,
		remotePath: row.remote_path,
		fileName: row.file_name,
		totalBytes: row.total_bytes,
		bytesTransferred: row.bytes_transferred,
		overwrite: row.overwrite === 1,
		status: row.status,
		target: JSON.parse(row.target_json) as SshTargetSnapshot,
		...(row.failure_json === null ? {} : { failure: JSON.parse(row.failure_json) as FileTransfer["failure"] }),
		createdAt: row.created_at,
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
		updatedAt: row.updated_at,
	};
}
