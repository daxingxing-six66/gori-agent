import type { ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import type { ChatContextUsage } from "@/features/chat/model/chat-context-usage";

export type { ThinkingLevel } from "@/features/llm-provider/model/llm-provider";

export type ChatRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type ChatQueueBehavior = "steer" | "follow_up";
export type ChatQueueItemStatus = "pending" | "consumed" | "cancelled";
export type ChatConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export interface ChatRun {
	id: string;
	sessionId: string;
	workspaceId: string;
	requestId: string;
	providerId: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	serverInteractionMode: "command" | "terminal";
	terminalSessionId: string | null;
	status: ChatRunStatus;
	failure?: { schemaVersion?: 1; upstreamStatus?: number; action?: "check_request" | "retry_later" | "contact_support"; errorId?: string; stage?: string; code: string; message: string; retryable: boolean; recovery?: { errorId: string; code: string; message: string } };
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface UserMessage {
	role: "user";
	content: string | Array<TextContent | ImageContent>;
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: Array<TextContent | ThinkingContent | ToolCallContent>;
	provider: string;
	model: string;
	stopReason: string;
	errorMessage?: string;
	failure?: ChatRun["failure"];
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	isError: boolean;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export interface SystemMessage {
	role: "system";
	content: TextContent[];
	timestamp: number;
	runtimeMode?: "command" | "terminal";
	runtimeEventId?: string;
}

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage | CompactionSummaryMessage;

export interface ChatMessage {
	id: string;
	sequence: number;
	runId?: string;
	message: AgentMessage;
	attachments?: SessionAttachment[];
	createdAt: number;
}

export type ManualChatCompactionResult =
	| { status: "skipped"; reason: "nothing_to_compact"; attempts: 0; contextUsage: ChatContextUsage | null }
	| {
		status: "completed";
		contextUsage: ChatContextUsage;
		reason: "manual";
		attempts: 1 | 2;
		message: ChatMessage;
		tokensBefore: number;
		estimatedTokensAfter: number;
		reductionPercent: number;
		model: { providerId: string; modelId: string; fallback: boolean };
	};

export interface ToolApproval {
	id: string;
	sessionId: string;
	runId: string;
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	description: string;
	status: "pending" | "approved" | "rejected";
	source?: "user" | "auto";
	rejectionReason?: "user_rejected" | "timeout" | "run_cancelled" | "server_restarted";
	createdAt: number;
	resolvedAt?: number;
}

export interface ChatQueueItem {
	id: string;
	sessionId: string;
	runId: string;
	requestId: string;
	behavior: ChatQueueBehavior;
	message: AgentMessage;
	status: ChatQueueItemStatus;
	createdAt: number;
	resolvedAt?: number;
}

export interface ChatQueuePatch {
	id: string;
	behavior?: ChatQueueBehavior;
	status: ChatQueueItemStatus;
	message?: string;
	resolvedAt?: number;
}

export interface ChatQueueEntry {
	id: string;
	status: ChatQueueItemStatus;
	sessionId?: string;
	runId?: string;
	requestId?: string;
	behavior?: ChatQueueBehavior;
	message?: AgentMessage | string;
	createdAt?: number;
	resolvedAt?: number;
}

export type ChatCompactionFailureCode =
	| "chat_context_overflow"
	| "chat_context_no_compactable_history"
	| "chat_credential_check_failed"
	| "chat_context_compaction_insufficient"
	| "chat_context_compaction_failed"
	| "chat_compaction_model_unavailable";

interface ChatCompactionEventModel {
	providerId: string;
	modelId: string;
	fallback: boolean;
}

export type ToolUpdate =
	| { type: "text"; detail: { content: string; mode: "replace" } }
	| { type: "progress"; detail: { current: number; total: number; unit: "bytes" | "items"; message?: string } }
	| { type: "status"; detail: { status: "preparing" | "waiting_for_approval" | "running"; message: string } };

export interface ChatToolExecution {
	toolCallId: string;
	toolName: string;
	status: "waiting" | "running" | "completed" | "failed";
	args?: unknown;
	latestUpdate?: ToolUpdate;
	result?: unknown;
	isError?: boolean;
	startedAt?: number;
	finishedAt?: number;
}

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; error: AssistantMessage };

export type ChatStreamEvent =
	| { type: "context.updated"; data: ChatContextUsage }
	| { type: "stream.resync"; data: { eventType: string } }
	| { type: "run.persistence_failed"; data: { runId: string; failure: NonNullable<ChatRun["failure"]> } }
	| { type: "stream.ready"; data: { runId: string; connectedAt: number } }
	| { type: "run.updated"; data: ChatRun }
	| { type: "message_start"; data: { type: "message_start"; message: AgentMessage } }
	| { type: "message_update"; data: { assistantMessageEvent: AssistantMessageEvent } }
	| { type: "message_end"; data: { type: "message_end"; message: AgentMessage } }
	| { type: "tool_execution_start"; data: { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown } }
	| { type: "tool_execution_update"; data: { type: "tool_execution_update"; toolCallId: string; toolName: string; update: ToolUpdate } }
	| { type: "tool_execution_end"; data: { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean } }
	| { type: "approval.requested" | "approval.resolved"; data: ToolApproval }
	| { type: "queue.updated"; data: ChatQueuePatch }
	| { type: "compaction.started"; data: { reason: "threshold" | "overflow"; attempt: 1 | 2; tokensBefore: number; thresholdTokens: number; model: ChatCompactionEventModel } }
	| { type: "compaction.completed"; data: { reason: "threshold" | "overflow"; attempt: 1 | 2; messageId: string; sequence: number; tokensBefore: number; estimatedTokensAfter: number; reductionPercent: number; model: ChatCompactionEventModel } }
	| { type: "compaction.failed"; data: { reason: "threshold" | "overflow"; attempt: 1 | 2; code: ChatCompactionFailureCode; message: string } }
	| { type: "agent_start" | "agent_end" | "turn_start" | "turn_end"; data: unknown };

export function isAgentMessage(value: unknown): value is AgentMessage {
	if (!isRecord(value) || typeof value.timestamp !== "number") return false;
	if (value.role === "system") return isContentArray(value.content, ["text"]);
	if (value.role === "user") return typeof value.content === "string" || isContentArray(value.content, ["text", "image"]);
	if (value.role === "assistant") return isContentArray(value.content, ["text", "thinking", "toolCall"]);
	if (value.role === "compactionSummary") return typeof value.summary === "string" && typeof value.tokensBefore === "number";
	if (value.role === "toolResult") {
		return typeof value.toolCallId === "string" && typeof value.toolName === "string" &&
			typeof value.isError === "boolean" && isContentArray(value.content, ["text", "image"]);
	}
	return false;
}

export function isChatRun(value: unknown): value is ChatRun {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && typeof value.sessionId === "string" && typeof value.workspaceId === "string" &&
		typeof value.requestId === "string" && typeof value.providerId === "string" && typeof value.modelId === "string" &&
		(value.serverInteractionMode === "command" || value.serverInteractionMode === "terminal") &&
		(value.terminalSessionId === null || typeof value.terminalSessionId === "string") &&
		isChatRunStatus(value.status) && typeof value.createdAt === "number" && typeof value.updatedAt === "number";
}

export function isToolApproval(value: unknown): value is ToolApproval {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && typeof value.sessionId === "string" && typeof value.runId === "string" &&
		typeof value.assistantMessageId === "string" && typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" && typeof value.description === "string" &&
		(value.status === "pending" || value.status === "approved" || value.status === "rejected") &&
		typeof value.createdAt === "number";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContentArray(value: unknown, allowed: string[]): boolean {
	return Array.isArray(value) && value.every((entry) => {
		if (!isRecord(entry) || typeof entry.type !== "string" || !allowed.includes(entry.type)) return false;
		if (entry.type === "text") return typeof entry.text === "string";
		if (entry.type === "thinking") return typeof entry.thinking === "string";
		if (entry.type === "image") return typeof entry.data === "string" && typeof entry.mimeType === "string";
		return entry.type === "toolCall" && typeof entry.id === "string" && typeof entry.name === "string" && isRecord(entry.arguments);
	});
}

function isChatRunStatus(value: unknown): value is ChatRunStatus {
	return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}
