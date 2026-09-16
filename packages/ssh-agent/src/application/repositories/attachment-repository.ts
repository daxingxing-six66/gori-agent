import type { Attachment } from "../../domain/attachment.ts";
import type { SessionId } from "../../domain/ids.ts";

export interface AttachmentRepository {
	insert(attachment: Attachment): Promise<void>;
	findBySessionIdAndName(sessionId: SessionId, name: string): Promise<Attachment | undefined>;
	findBySessionIdAndIds(sessionId: SessionId, ids: readonly string[]): Promise<Attachment[]>;
	listBySessionId(sessionId: SessionId): Promise<Attachment[]>;
}
