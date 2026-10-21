import { apiRequest } from "@/shared/api/client";

export interface ReaderFile {
	path: string;
	name: string;
	content: string;
	size: number;
	modifiedAt: number;
}

export const fileReaderApi = {
	read: (sessionId: string, path: string, signal: AbortSignal) => apiRequest<ReaderFile>(
		`/api/sessions/${encodeURIComponent(sessionId)}/local-files/content?path=${encodeURIComponent(path)}`, { signal }),
	readAttachment: (sessionId: string, attachmentId: string, signal: AbortSignal) => apiRequest<ReaderFile>(
		`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/text`, { signal }),
};
