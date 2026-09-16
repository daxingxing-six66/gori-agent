import type { BackendMessageKey, BackendMessageValues } from "../i18n/message.ts";
import type {
	SessionId,
	TerminalInputId,
	TerminalInteractionId,
	TerminalObservationId,
	TerminalSessionId,
	WorkspaceId,
} from "./ids.ts";

export type TerminalSessionStatus = "opening" | "active" | "closing" | "closed" | "failed" | "lost";
export type TerminalCloseReason =
	| "user_requested"
	| "idle_timeout"
	| "session_deleted"
	| "shell_exited"
	| "connection_lost"
	| "backend_shutdown"
	| "backend_restarted"
	| "open_failed";
export type ServerInteractionMode = "command" | "terminal";

export interface TerminalGeometry {
	readonly rows: number;
	readonly cols: number;
}

export interface TerminalSession {
	readonly id: TerminalSessionId;
	readonly sessionId: SessionId;
	readonly workspaceId: WorkspaceId;
	readonly openRequestId: string;
	readonly closeRequestId: string | null;
	readonly status: TerminalSessionStatus;
	readonly revision: number;
	readonly geometry: TerminalGeometry;
	readonly eventSequence: number;
	readonly ownershipEpoch: number;
	readonly connectionGeneration: number | null;
	readonly term: "xterm-256color";
	readonly activatedAt: number | null;
	readonly lastConsumerActivityAt: number;
	readonly idleDeadlineAt: number | null;
	readonly closingAt: number | null;
	readonly closedAt: number | null;
	readonly closeReason: TerminalCloseReason | null;
	readonly failureCode: string | null;
	readonly failureMessage: string | null;
	readonly failureMessageKey?: BackendMessageKey | null;
	readonly failureMessageValues?: BackendMessageValues | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type TerminalObservationExpectation = "finite" | "interactive" | "streaming";
export type TerminalInteractionRequestAction =
	| { readonly type: "submit"; readonly input: string }
	| { readonly type: "key"; readonly key: "CTRL_C" }
	| { readonly type: "observe" };
export type TerminalInteractionAction =
	| { readonly type: "submit" }
	| { readonly type: "key"; readonly key: "CTRL_C" }
	| { readonly type: "observe" };
export type TerminalInteractionStatus =
	| "prepared"
	| "awaiting_approval"
	| "approved"
	| "writing"
	| "observing"
	| "completed"
	| "rejected"
	| "cancelled"
	| "failed"
	| "write_uncertain";

export interface TerminalGuardDecision {
	readonly allowed: boolean;
	readonly guardRevision: number | null;
	readonly matchedRuleId: string | null;
	readonly reason: string | null;
}

export interface TerminalInteractionFailure {
	readonly code: string;
}

export interface TerminalInteraction {
	readonly id: TerminalInteractionId;
	readonly terminalSessionId: TerminalSessionId;
	readonly sessionId: SessionId;
	readonly agentRunId: string;
	readonly toolCallId: string;
	readonly action: TerminalInteractionAction;
	readonly expectation: TerminalObservationExpectation;
	readonly status: TerminalInteractionStatus;
	readonly inputSequence: number | null;
	readonly observationId: TerminalObservationId | null;
	readonly guardDecision: TerminalGuardDecision | null;
	readonly approvalRequired: boolean;
	readonly failure: TerminalInteractionFailure | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly completedAt: number | null;
}

export type TerminalInputKind = "submit" | "semantic_key";
export type TerminalInputStatus = "prepared" | "written" | "uncertain" | "blocked";

export interface TerminalInput {
	readonly id: TerminalInputId;
	readonly interactionId: TerminalInteractionId;
	readonly terminalSessionId: TerminalSessionId;
	readonly displayText: string;
	readonly inputKind: TerminalInputKind;
	readonly encodedBytes: Uint8Array;
	readonly byteLength: number;
	readonly status: TerminalInputStatus;
	readonly terminalSequence: number | null;
	readonly guardRevision: number | null;
	readonly matchedGuardRuleId: string | null;
	readonly createdAt: number;
	readonly writtenAt: number | null;
}

export type TerminalObservationKind = "transcript" | "screen";
export type TerminalBoundaryReason = "channel_closed" | "output_limit" | "prompt" | "snapshot" | "quiet" | "timeout";

export interface TerminalObservation {
	readonly id: TerminalObservationId;
	readonly interactionId: TerminalInteractionId;
	readonly terminalSessionId: TerminalSessionId;
	readonly startSequence: number;
	readonly endSequence: number;
	readonly kind: TerminalObservationKind;
	readonly geometry: TerminalGeometry;
	readonly boundaryReason: TerminalBoundaryReason;
	readonly agentViewText: string;
	readonly rawByteCount: number;
	readonly truncated: boolean;
	readonly capturedAt: number;
	readonly deliveredAt: number | null;
	readonly processingAt: number | null;
	readonly finishedAt: number | null;
}

export type TerminalTimelineEventType =
	| "terminal.opening"
	| "terminal.active"
	| "terminal.closing"
	| "terminal.closed"
	| "terminal.failed"
	| "terminal.lost"
	| "terminal.input"
	| "observation.captured"
	| "observation.delivered"
	| "observation.processing"
	| "observation.finished";

export interface TerminalTimelineEvent {
	readonly id: string;
	readonly terminalSessionId: TerminalSessionId;
	readonly sessionId: SessionId;
	readonly timelineSequence: number;
	readonly terminalEventSequence: number | null;
	readonly type: TerminalTimelineEventType;
	readonly interactionId: TerminalInteractionId | null;
	readonly observationId: TerminalObservationId | null;
	readonly agentRunId: string | null;
	readonly data: unknown;
	readonly createdAt: number;
}

export interface TerminalErrorDetails {
	readonly terminalSessionId?: TerminalSessionId;
	readonly status?: TerminalSessionStatus;
	readonly ownershipEpoch?: number;
	readonly retryAfterMs?: number;
}

export class TerminalError extends Error {
	readonly code: string;
	readonly status: number;
	readonly retryable: boolean;
	readonly details: TerminalErrorDetails;

	constructor(
		code: string,
		message: string,
		options: { readonly status?: number; readonly retryable?: boolean; readonly details?: TerminalErrorDetails } = {},
	) {
		super(message);
		this.name = "TerminalError";
		this.code = code;
		this.status = options.status ?? 400;
		this.retryable = options.retryable ?? false;
		this.details = options.details ?? {};
	}
}

export function effectiveServerInteractionMode(status: TerminalSessionStatus | null): ServerInteractionMode {
	return status === "active" ? "terminal" : "command";
}

export function isLiveTerminalStatus(status: TerminalSessionStatus): boolean {
	return status === "opening" || status === "active" || status === "closing";
}
