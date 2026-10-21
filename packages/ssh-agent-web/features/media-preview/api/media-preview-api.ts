import { apiRequest, apiUrl } from "@/shared/api/client";
import type { MediaFile } from "../model/media-file";

function endpoint(sessionId: string) { return `/api/sessions/${encodeURIComponent(sessionId)}/media-preview`; }
export const mediaPreviewApi = {
	inspect: (sessionId: string, path: string, signal: AbortSignal) => apiRequest<MediaFile>(`${endpoint(sessionId)}?path=${encodeURIComponent(path)}`, { signal }),
	contentUrl: (sessionId: string, path: string, revision: number) => apiUrl(`${endpoint(sessionId)}/content?path=${encodeURIComponent(path)}&revision=${revision}`),
};
