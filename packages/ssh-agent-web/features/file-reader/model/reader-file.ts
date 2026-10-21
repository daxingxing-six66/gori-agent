import { localPathIdentity } from "@/shared/files/local-path";
export { localPathIdentity as readerPath } from "@/shared/files/local-path";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";

export type ReaderSource =
	| { kind: "local"; path: string }
	| { kind: "attachment"; attachmentId: string };

export interface ReaderDocument {
	id: string;
	name: string;
	source: ReaderSource;
	revision: number;
}

export function readerDocument(path: string, workDir?: string | null): ReaderDocument {
	const normalized = localPathIdentity(path, workDir);
	return { id: `reader:local:${normalized}`, source: { kind: "local", path: normalized }, name: normalized.split("/").at(-1) || normalized, revision: 0 };
}

export function attachmentReaderDocument(attachment: Pick<SessionAttachment, "id" | "sessionId" | "name">): ReaderDocument {
	return {
		id: `reader:attachment:${attachment.sessionId}:${attachment.id}`,
		name: attachment.name,
		source: { kind: "attachment", attachmentId: attachment.id },
		revision: 0,
	};
}
