import { apiUpload } from "@/shared/api/client";

export interface SessionAttachment {
	id: string;
	sessionId: string;
	name: string;
	mimeType: string;
	size: number;
	storagePath: string;
	contentUrl: string;
	createdAt: number;
}

export const sessionAttachmentApi = {
	upload: (sessionId: string, file: File, signal?: AbortSignal) =>
		apiUpload<SessionAttachment>(
			`/api/sessions/${encodeURIComponent(sessionId)}/attachments?name=${encodeURIComponent(file.name)}`,
			file,
			{ contentType: file.type || "application/octet-stream", signal },
		),
};
