import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BackendMessageKey, BackendMessageValues } from "../i18n/message.ts";
import type { Attachment } from "./attachment.ts";
import type { ServerInteractionMode } from "./terminal.ts";

export type ChatRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface ChatModelSelection {
	providerId: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

export interface ChatRun {
	id: string;
	sessionId: string;
	workspaceId: string;
	requestId: string;
	providerId: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	serverInteractionMode: ServerInteractionMode;
	terminalSessionId: string | null;
	status: ChatRunStatus;
	failure?: {
		schemaVersion?: 1;
		action?: "check_request" | "retry_later" | "contact_support";
		errorId?: string;
		stage?: string;
		recovery?: {
			errorId: string;
			code: string;
			message: string;
			messageKey?: BackendMessageKey;
			messageValues?: BackendMessageValues;
		};
		upstreamStatus?: number;
		code: string;
		message: string;
		messageKey?: BackendMessageKey;
		messageValues?: BackendMessageValues;
		retryable: boolean;
	};
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
}

export type ChatQueueBehavior = "steer" | "follow_up";
export type ChatQueueItemStatus = "pending" | "consumed" | "cancelled";

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

export type ToolApprovalStatus = "pending" | "approved" | "rejected";

export interface ToolApproval {
	id: string;
	sessionId: string;
	runId: string;
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	description: string;
	descriptionMessageKey?: BackendMessageKey;
	descriptionValues?: BackendMessageValues;
	status: ToolApprovalStatus;
	source?: "user" | "auto";
	rejectionReason?: "user_rejected" | "timeout" | "run_cancelled" | "server_restarted";
	createdAt: number;
	resolvedAt?: number;
}

export interface ChatMessageProjection {
	id: string;
	sequence: number;
	runId?: string;
	message: AgentMessage;
	attachments?: Attachment[];
	createdAt: number;
}

export type ChatMessageListCursor =
	| { direction: "latest" }
	| { direction: "before"; sequence: number }
	| { direction: "after"; sequence: number };

export interface ChatMessagePage {
	messages: ChatMessageProjection[];
	nextBeforeSequence: number | null;
	nextSequence: number | null;
}

export class ChatError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status = 400, options?: ErrorOptions) {
		super(message, options);
		this.name = "ChatError";
		this.code = code;
		this.status = status;
	}
}
