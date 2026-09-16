import type { AttachmentId, SessionId } from "./ids.ts";

export interface Attachment {
	id: AttachmentId;
	sessionId: SessionId;
	name: string;
	mimeType: string;
	size: number;
	storagePath: string;
	createdAt: number;
}

export type AttachmentErrorCode =
	| "attachment_not_found"
	| "attachment_name_invalid"
	| "attachment_mime_type_invalid"
	| "attachment_too_large"
	| "attachment_size_mismatch"
	| "attachment_upload_cancelled"
	| "attachment_content_cancelled"
	| "attachment_image_format_unsupported"
	| "attachment_content_invalid"
	| "attachment_changed"
	| "attachment_storage_unavailable";

export class AttachmentError extends Error {
	readonly code: AttachmentErrorCode;
	readonly status: number;
	readonly field?: string;

	constructor(code: AttachmentErrorCode, message: string, status: number, field?: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AttachmentError";
		this.code = code;
		this.status = status;
		this.field = field;
	}
}
