import type { Session, SessionDetails } from "@/features/session/model/session";
import { apiRequest } from "@/shared/api/client";

export const sessionApi = {
	create: (workspaceId: string, displayName: string, options?: { workDir?: string; autoAudit?: boolean }) =>
		apiRequest<Session>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
			method: "POST",
			body: { displayName, ...options },
		}),
	get: (sessionId: string, signal?: AbortSignal) =>
		apiRequest<SessionDetails>(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal }),
	rename: (sessionId: string, displayName: string, expectedRevision: number) =>
		apiRequest<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "PATCH",
			body: { displayName, expectedRevision },
		}),
	update: (sessionId: string, input: { displayName?: string; workDir?: string | null; autoAudit?: boolean; expectedRevision: number }) =>
		apiRequest<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: input }),
	delete: (sessionId: string, expectedRevision: number) =>
		apiRequest<void>(
			`/api/sessions/${encodeURIComponent(sessionId)}?expectedRevision=${encodeURIComponent(expectedRevision)}`,
			{ method: "DELETE" },
		),
};
