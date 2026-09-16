import type { DatabaseSync } from "node:sqlite";
import type { AttachmentRepository } from "../../application/repositories/attachment-repository.ts";
import type { Attachment } from "../../domain/attachment.ts";
import type { SessionId } from "../../domain/ids.ts";

const COLUMNS = "id, session_id, name, mime_type, size, storage_path, created_at";

interface AttachmentRow {
	id: string;
	session_id: string;
	name: string;
	mime_type: string;
	size: number;
	storage_path: string;
	created_at: number;
}

export class SqliteAttachmentRepository implements AttachmentRepository {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	async insert(attachment: Attachment): Promise<void> {
		this.#database
			.prepare(`INSERT INTO attachments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(
				attachment.id,
				attachment.sessionId,
				attachment.name,
				attachment.mimeType,
				attachment.size,
				attachment.storagePath,
				attachment.createdAt,
			);
	}

	async findBySessionIdAndName(sessionId: SessionId, name: string): Promise<Attachment | undefined> {
		const row = this.#database
			.prepare(`SELECT ${COLUMNS} FROM attachments WHERE session_id = ? AND name = ?`)
			.get(sessionId, name);
		return row === undefined ? undefined : fromRow(row as unknown as AttachmentRow);
	}

	async findBySessionIdAndIds(sessionId: SessionId, ids: readonly string[]): Promise<Attachment[]> {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(", ");
		return this.#database
			.prepare(`SELECT ${COLUMNS} FROM attachments WHERE session_id = ? AND id IN (${placeholders})`)
			.all(sessionId, ...ids)
			.map((row) => fromRow(row as unknown as AttachmentRow));
	}

	async listBySessionId(sessionId: SessionId): Promise<Attachment[]> {
		return this.#database
			.prepare(`SELECT ${COLUMNS} FROM attachments WHERE session_id = ? ORDER BY created_at DESC, id DESC`)
			.all(sessionId)
			.map((row) => fromRow(row as unknown as AttachmentRow));
	}
}

function fromRow(row: AttachmentRow): Attachment {
	return {
		id: row.id,
		sessionId: row.session_id,
		name: row.name,
		mimeType: row.mime_type,
		size: row.size,
		storagePath: row.storage_path,
		createdAt: row.created_at,
	};
}
