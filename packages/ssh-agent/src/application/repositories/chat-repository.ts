import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ChatMessageProjection,
	ChatModelSelection,
	ChatQueueBehavior,
	ChatQueueItem,
	ChatQueueItemStatus,
	ChatRun,
	ToolApproval,
} from "../../domain/chat.ts";
import type { StoredChatCompactionMessage } from "../../domain/context-compaction.ts";

export interface StoredChatCompaction {
	id: string;
	sequence: number;
	runId?: string;
	message: StoredChatCompactionMessage;
	createdAt: number;
}

export interface ChatRepository {
	recoverInterrupted(now: number): void;
	findRunByRequest(sessionId: string, requestId: string): ChatRun | undefined;
	findRun(runId: string, sessionId: string): ChatRun | undefined;
	findLatestRun(sessionId: string): ChatRun | undefined;
	findLatestModelSelection(sessionId: string): ChatModelSelection | undefined;
	hasActiveProvider(providerId: string): boolean;
	insertRun(run: ChatRun): void;
	updateRun(run: ChatRun): void;
	findQueueItemByRequest(
		sessionId: string,
		requestId: string,
	): { id: string; status: ChatQueueItemStatus } | undefined;
	insertQueueItem(item: ChatQueueItem): void;
	promoteQueueItem(sessionId: string, runId: string, itemId: string): boolean;
	findPendingQueueBehavior(sessionId: string, runId: string, itemId: string): ChatQueueBehavior | undefined;
	cancelQueueItem(sessionId: string, runId: string, itemId: string, resolvedAt: number): boolean;
	listPendingQueueMessages(sessionId: string, runId: string, behavior: ChatQueueBehavior): AgentMessage[];
	cancelPendingQueueByBehavior(
		sessionId: string,
		runId: string,
		behavior: ChatQueueBehavior,
		resolvedAt: number,
	): string[];
	cancelPendingQueue(sessionId: string, runId: string, resolvedAt: number): string[];
	consumePendingQueueMessage(
		sessionId: string,
		runId: string,
		message: AgentMessage,
		resolvedAt: number,
	): string | undefined;
	listQueue(sessionId: string, runId: string, status: ChatQueueItemStatus): ChatQueueItem[];
	appendMessage(id: string, sessionId: string, runId: string, message: AgentMessage, createdAt: number): void;
	appendCompaction(
		id: string,
		sessionId: string,
		runId: string | null,
		message: StoredChatCompactionMessage,
		createdAt: number,
	): ChatMessageProjection;
	listMessages(sessionId: string, afterSequence?: number, limit?: number): ChatMessageProjection[];
	listMessagesBefore(sessionId: string, beforeSequence: number | undefined, limit: number): ChatMessageProjection[];
	insertApproval(approval: ToolApproval): void;
	findApproval(sessionId: string, approvalId: string): ToolApproval | undefined;
	listApprovals(sessionId: string, status: string): ToolApproval[];
	resolveApproval(approvalId: string, approved: boolean, resolvedAt: number): ToolApproval;
	rejectPendingApproval(
		approvalId: string,
		reason: NonNullable<ToolApproval["rejectionReason"]>,
		resolvedAt: number,
	): ToolApproval | undefined;
	latestSystemMessage(sessionId: string): ChatMessageProjection | undefined;
	latestCompaction(sessionId: string): StoredChatCompaction | undefined;
}
