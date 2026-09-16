import {
	isAgentMessage,
	isChatRun,
	isRecord,
	isToolApproval,
	type AssistantMessage,
	type AssistantMessageEvent,
	type ChatConnectionState,
	type ChatQueuePatch,
	type ChatStreamEvent,
	type ToolUpdate,
} from "@/features/chat/model/chat";
import type { SupportedLocale } from "@/features/i18n/model/locale";
import { apiUrlWithLocale } from "@/shared/api/client";
import { isChatContextUsage } from "@/features/chat/model/chat-context-usage";

const EVENT_TYPES = [
	"context.updated", "run.persistence_failed", "stream.resync",
	"agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
	"tool_execution_start", "tool_execution_update", "tool_execution_end", "run.updated", "queue.updated",
	"approval.requested", "approval.resolved", "compaction.started", "compaction.completed", "compaction.failed", "stream.ready",
] as const;

interface EventSourceLike {
	addEventListener(type: string, listener: (event: Event) => void): void;
	close(): void;
	onerror: ((event: Event) => void) | null;
	onopen: ((event: Event) => void) | null;
}
type EventSourceFactory = (url: string) => EventSourceLike;

export class ChatEventStream {
	private readonly source: EventSourceLike;
	private readonly eventListeners = new Set<(event: ChatStreamEvent) => void>();
	private readonly connectionListeners = new Set<(state: ChatConnectionState) => void>();
	private readyCount = 0;

	constructor(
		sessionId: string,
		runId: string,
		locale: SupportedLocale,
		factory: EventSourceFactory = (url) => {
			const source = new EventSource(url);
			return {
				addEventListener: (type, listener) => source.addEventListener(type, listener),
				close: () => source.close(),
				get onerror() { return source.onerror; },
				set onerror(listener) { source.onerror = listener; },
				get onopen() { return source.onopen; },
				set onopen(listener) { source.onopen = listener; },
			};
		},
	) {
		this.source = factory(apiUrlWithLocale(`/api/sessions/${encodeURIComponent(sessionId)}/chat/runs/${encodeURIComponent(runId)}/events`, locale));
		this.source.onopen = () => this.emitConnection(this.readyCount === 0 ? "connecting" : "reconnecting");
		this.source.onerror = () => this.emitConnection("reconnecting");
		for (const type of EVENT_TYPES) {
			this.source.addEventListener(type, (event) => {
				const parsed = parseChatStreamEvent(type, messageData(event));
				if (!parsed) {
					console.error("Invalid Chat SSE event", { runId, type });
					for (const listener of this.eventListeners) listener({ type: "stream.resync", data: { eventType: type } });
					return;
				}
				if (parsed.type === "stream.ready") {
					this.readyCount += 1;
					this.emitConnection("connected");
				}
				for (const listener of this.eventListeners) listener(parsed);
			});
		}
	}

	subscribe(listener: (event: ChatStreamEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	subscribeConnection(listener: (state: ChatConnectionState) => void): () => void {
		this.connectionListeners.add(listener);
		listener("connecting");
		return () => this.connectionListeners.delete(listener);
	}

	close(): void {
		this.source.close();
		this.emitConnection("closed");
		this.eventListeners.clear();
		this.connectionListeners.clear();
	}

	private emitConnection(state: ChatConnectionState): void {
		for (const listener of this.connectionListeners) listener(state);
	}
}

export function parseChatStreamEvent(type: string, data: unknown): ChatStreamEvent | null {
	if (type === "stream.resync") return isRecord(data) && typeof data.eventType === "string" ? { type, data: { eventType: data.eventType } } : null;
	if (type === "context.updated") return isChatContextUsage(data) ? { type, data } : null;
	if (type === "run.persistence_failed") {
		if (!isRecord(data) || typeof data.runId !== "string" || !isRecord(data.failure) || typeof data.failure.code !== "string" || typeof data.failure.message !== "string" || typeof data.failure.retryable !== "boolean") return null;
		return { type, data: { runId: data.runId, failure: { code: data.failure.code, message: data.failure.message, retryable: data.failure.retryable, ...(typeof data.failure.errorId === "string" ? { errorId: data.failure.errorId } : {}) } } };
	}
	if (type === "run.updated") return isChatRun(data) ? { type, data } : null;
	if (type === "message_start") {
		if (!isRecord(data) || !isAgentMessage(data.message)) return null;
		return { type, data: { type, message: data.message } };
	}
	if (type === "message_end") {
		if (!isRecord(data) || !isAgentMessage(data.message)) return null;
		return { type, data: { type, message: data.message } };
	}
	if (type === "message_update") {
		if (!isRecord(data) || !isAssistantMessageEvent(data.assistantMessageEvent)) return null;
		return { type, data: { assistantMessageEvent: data.assistantMessageEvent } };
	}
	if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
		if (!isRecord(data) || typeof data.toolCallId !== "string" || typeof data.toolName !== "string") return null;
		if (type === "tool_execution_start") return { type, data: { type, toolCallId: data.toolCallId, toolName: data.toolName, args: data.args } };
		if (type === "tool_execution_update") return isToolUpdate(data.update)
			? { type, data: { type, toolCallId: data.toolCallId, toolName: data.toolName, update: data.update } }
			: null;
		return typeof data.isError === "boolean"
			? { type, data: { type, toolCallId: data.toolCallId, toolName: data.toolName, result: data.result, isError: data.isError } }
			: null;
	}
	if (type === "approval.requested" || type === "approval.resolved") return isToolApproval(data) ? { type, data } : null;
	if (type === "queue.updated") return isQueuePatch(data) ? { type, data } : null;
	if (type === "stream.ready") {
		return isRecord(data) && typeof data.runId === "string" && typeof data.connectedAt === "number"
			? { type, data: { runId: data.runId, connectedAt: data.connectedAt } }
			: null;
	}
	if (type === "compaction.started") {
		return isCompactionEnvelope(data) && typeof data.thresholdTokens === "number" && isCompactionModel(data.model)
			? { type, data: { reason: data.reason, attempt: data.attempt, tokensBefore: data.tokensBefore, thresholdTokens: data.thresholdTokens, model: data.model } }
			: null;
	}
	if (type === "compaction.completed") {
		return isCompactionEnvelope(data) && typeof data.messageId === "string" && typeof data.sequence === "number" &&
			typeof data.estimatedTokensAfter === "number" && typeof data.reductionPercent === "number" && isCompactionModel(data.model)
			? { type, data: { reason: data.reason, attempt: data.attempt, messageId: data.messageId, sequence: data.sequence, tokensBefore: data.tokensBefore, estimatedTokensAfter: data.estimatedTokensAfter, reductionPercent: data.reductionPercent, model: data.model } }
			: null;
	}
	if (type === "compaction.failed") {
		return isRecord(data) && (data.reason === "threshold" || data.reason === "overflow") && (data.attempt === 1 || data.attempt === 2) && isCompactionFailureCode(data.code) && typeof data.message === "string"
			? { type, data: { reason: data.reason, attempt: data.attempt, code: data.code, message: data.message } }
			: null;
	}
	if (type === "agent_start" || type === "agent_end" || type === "turn_start" || type === "turn_end") return { type, data };
	return null;
}

function messageData(event: Event): unknown {
	if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
	try {
		return JSON.parse(event.data) as unknown;
	} catch {
		return null;
	}
}

function isAssistantMessageEvent(value: unknown): value is AssistantMessageEvent {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	const message = value.type === "done" ? value.message : value.type === "error" ? value.error : value.partial;
	if (!isAssistantMessage(message)) return false;
	if (value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta") return typeof value.delta === "string";
	return ["start", "text_start", "text_end", "thinking_start", "thinking_end", "toolcall_start", "toolcall_end", "done", "error"].includes(value.type);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isAgentMessage(value) && value.role === "assistant";
}

function isQueuePatch(value: unknown): value is ChatQueuePatch {
	if (!isRecord(value) || typeof value.id !== "string") return false;
	return value.status === "pending" || value.status === "consumed" || value.status === "cancelled";
}

function isToolUpdate(value: unknown): value is ToolUpdate {
	if (!isRecord(value) || !isRecord(value.detail)) return false;
	if (value.type === "text") {
		return typeof value.detail.content === "string" && value.detail.mode === "replace";
	}
	if (value.type === "progress") {
		const { current, total, unit, message } = value.detail;
		return typeof current === "number" && Number.isFinite(current) && current >= 0 &&
			typeof total === "number" && Number.isFinite(total) && total >= 0 && current <= total &&
			(unit === "bytes" || unit === "items") && (message === undefined || typeof message === "string");
	}
	if (value.type === "status") {
		return (value.detail.status === "preparing" || value.detail.status === "waiting_for_approval" || value.detail.status === "running") &&
			typeof value.detail.message === "string";
	}
	return false;
}

function isCompactionEnvelope(value: unknown): value is Record<string, unknown> & {
	reason: "threshold" | "overflow";
	attempt: 1 | 2;
	tokensBefore: number;
} {
	return isRecord(value) && (value.reason === "threshold" || value.reason === "overflow") &&
		(value.attempt === 1 || value.attempt === 2) && typeof value.tokensBefore === "number";
}

function isCompactionModel(value: unknown): value is { providerId: string; modelId: string; fallback: boolean } {
	return isRecord(value) && typeof value.providerId === "string" && typeof value.modelId === "string" && typeof value.fallback === "boolean";
}

function isCompactionFailureCode(value: unknown): value is Extract<ChatStreamEvent, { type: "compaction.failed" }>["data"]["code"] {
	return value === "chat_context_no_compactable_history" || value === "chat_credential_check_failed" || value === "chat_context_overflow" || value === "chat_context_compaction_insufficient" ||
		value === "chat_context_compaction_failed" || value === "chat_compaction_model_unavailable";
}
