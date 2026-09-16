import {
	requireTerminalAttachment,
	requireTerminalObservation,
	requireTerminalOwnership,
	requireTerminalSession,
	requireTerminalStatus,
	requireTerminalTimeline,
} from "@/features/terminal/model/terminal";
import { apiRequest } from "@/shared/api/client";

const root = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/terminal`;

export const terminalApi = {
	getStatus: async (sessionId: string, signal?: AbortSignal) =>
		requireTerminalStatus(await apiRequest<unknown>(root(sessionId), { signal })),
	open: async (sessionId: string, requestId: string) =>
		requireTerminalSession(await apiRequest<unknown>(`${root(sessionId)}/open`, { method: "POST", body: { requestId } })),
	close: async (sessionId: string, terminalSessionId: string, requestId: string) =>
		requireTerminalSession(
			await apiRequest<unknown>(`${root(sessionId)}/close`, {
				method: "POST",
				body: { requestId, terminalSessionId },
			}),
		),
	attach: async (sessionId: string, requestId: string) =>
		requireTerminalAttachment(
			await apiRequest<unknown>(`${root(sessionId)}/attachments`, { method: "POST", body: { requestId } }),
		),
	ready: (sessionId: string, attachmentId: string, replayedThroughSequence: number) =>
		apiRequest<void>(`${root(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/ready`, {
			method: "POST",
			body: { replayedThroughSequence },
		}),
	focus: async (sessionId: string, attachmentId: string, focused: boolean) =>
		requireTerminalOwnership(await apiRequest<unknown>(
			`${root(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/focus`,
			{ method: "POST", body: { focused } },
		)),
	resize: (sessionId: string, attachmentId: string, ownershipEpoch: number, rows: number, cols: number) =>
		apiRequest<void>(`${root(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/resize`, {
			method: "POST",
			body: { ownershipEpoch, rows, cols },
		}),
	detach: (sessionId: string, attachmentId: string) =>
		apiRequest<void>(`${root(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" }),
	listTimeline: async (sessionId: string, limit = 100) =>
		requireTerminalTimeline(await apiRequest<unknown>(`${root(sessionId)}/timeline?limit=${limit}`)),
	getObservation: async (sessionId: string, observationId: string) =>
		requireTerminalObservation(
			await apiRequest<unknown>(`${root(sessionId)}/observations/${encodeURIComponent(observationId)}`),
		),
};
