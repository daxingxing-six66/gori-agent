import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { BackendMessageDescriptor } from "../i18n/message.ts";
import type { ChatMessageProjection } from "./chat.ts";
import type { ChatContextUsage } from "./chat-context-usage.ts";

export type ChatCompactionReason = "threshold" | "overflow" | "manual";

export interface ChatCompactionModelSelection {
	providerId: string;
	modelId: string;
}

export interface ChatCompactionSettings {
	triggerPercent: number;
	model: ChatCompactionModelSelection | null;
	revision: number;
	updatedAt: number;
}

export interface UpdateChatCompactionSettingsInput {
	triggerPercent: number;
	model: ChatCompactionModelSelection | null;
	expectedRevision: number;
}

export interface StoredChatCompactionMessage {
	role: "compactionSummary";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	details?: unknown;
	usage?: Usage;
	reason: ChatCompactionReason;
	attempt: 1 | 2;
	provider: string;
	model: string;
	timestamp: number;
}

export type ManualChatCompactionResult =
	| { status: "skipped"; reason: "nothing_to_compact"; attempts: 0; contextUsage: ChatContextUsage | null }
	| {
			status: "completed";
			contextUsage: ChatContextUsage;
			reason: "manual";
			attempts: 1 | 2;
			message: ChatMessageProjection;
			tokensBefore: number;
			estimatedTokensAfter: number;
			reductionPercent: number;
			model: ChatCompactionModelSelection & { fallback: boolean };
	  };

export class ChatCompactionError extends Error {
	readonly code:
		| "chat_context_overflow"
		| "chat_context_no_compactable_history"
		| "chat_credential_check_failed"
		| "chat_context_compaction_insufficient"
		| "chat_context_compaction_failed"
		| "chat_compaction_model_unavailable";
	readonly status: number;
	readonly retryable: boolean;
	readonly publicMessage?: BackendMessageDescriptor;

	constructor(
		code: ChatCompactionError["code"],
		message: string,
		options: { status?: number; retryable?: boolean; cause?: unknown; publicMessage?: BackendMessageDescriptor } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "ChatCompactionError";
		this.code = code;
		this.status = options.status ?? 409;
		this.retryable = options.retryable ?? false;
		this.publicMessage = options.publicMessage;
	}
}
