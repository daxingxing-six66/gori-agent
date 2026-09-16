import type {
	ChatMessage,
	ManualChatCompactionResult,
	ChatQueueItem,
	ChatQueueItemStatus,
	ChatRun,
	ThinkingLevel,
	ToolApproval,
} from "@/features/chat/model/chat";
import { apiRequest } from "@/shared/api/client";
import type { ChatContextUsage } from "@/features/chat/model/chat-context-usage";

const root = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/chat`;

type ListMessagesOptions = { limit?: number } & (
	| { beforeSequence?: never; afterSequence?: never }
	| { beforeSequence: number; afterSequence?: never }
	| { beforeSequence?: never; afterSequence: number }
);

export const chatApi = {
	getContextUsage: (sessionId: string, signal?: AbortSignal) =>
		apiRequest<{ contextUsage: ChatContextUsage | null }>(`${root(sessionId)}/context-usage`, { signal }),
	createRun: (sessionId: string, input: { requestId: string; providerId: string; modelId: string; thinkingLevel?: ThinkingLevel; message: string; attachmentIds?: string[]; serverInteractionMode: "command" | "terminal" }) =>
		apiRequest<ChatRun>(`${root(sessionId)}/runs`, { method: "POST", body: input }),
	getActiveRun: (sessionId: string) =>
		apiRequest<{ run: ChatRun | null }>(`${root(sessionId)}/runs/active`),
	listMessages: (sessionId: string, options: ListMessagesOptions = {}) => {
		const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
		if (options.beforeSequence !== undefined) query.set("beforeSequence", String(options.beforeSequence));
		if (options.afterSequence !== undefined) query.set("afterSequence", String(options.afterSequence));
		return apiRequest<{ messages: ChatMessage[]; nextBeforeSequence: number | null; nextSequence: number | null }>(`${root(sessionId)}/messages?${query}`);
	},
	compact: (sessionId: string, signal?: AbortSignal) =>
		apiRequest<ManualChatCompactionResult>(`${root(sessionId)}/compactions`, { method: "POST", signal }),
	enqueue: (sessionId: string, runId: string, input: { requestId: string; behavior: "steer" | "follow_up"; message: string; attachmentIds?: string[] }) =>
		apiRequest<{ id: string; status: "pending" }>(`${root(sessionId)}/runs/${encodeURIComponent(runId)}/queue`, { method: "POST", body: input }),
	listQueue: (sessionId: string, runId: string, status: ChatQueueItemStatus = "pending") => {
		const query = new URLSearchParams({ status });
		return apiRequest<{ items: ChatQueueItem[] }>(`${root(sessionId)}/runs/${encodeURIComponent(runId)}/queue?${query}`);
	},
	cancelQueued: (sessionId: string, runId: string, queueItemId: string) =>
		apiRequest<void>(`${root(sessionId)}/runs/${encodeURIComponent(runId)}/queue/${encodeURIComponent(queueItemId)}`, { method: "DELETE" }),
	promoteQueued: (sessionId: string, runId: string, queueItemId: string) =>
		apiRequest<ChatQueueItem>(`${root(sessionId)}/runs/${encodeURIComponent(runId)}/queue/${encodeURIComponent(queueItemId)}/steer`, { method: "POST" }),
	cancelRun: (sessionId: string, runId: string) =>
		apiRequest<ChatRun>(`${root(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
	listApprovals: (sessionId: string) =>
		apiRequest<{ approvals: ToolApproval[] }>(`${root(sessionId)}/approvals?status=pending`),
	resolveApproval: (sessionId: string, approvalId: string, approved: boolean) =>
		apiRequest<ToolApproval>(`${root(sessionId)}/approvals/${encodeURIComponent(approvalId)}/${approved ? "approve" : "reject"}`, { method: "POST" }),
};
