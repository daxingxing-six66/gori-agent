import type { OperationId, SessionId, WorkspaceId } from "./ids.ts";
import type { SshFailure } from "./ssh-failure.ts";
import type { SshTargetSnapshot } from "./ssh-target.ts";

export type CommandOperationStatus =
	| "created"
	| "queued"
	| "dispatching"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked"
	| "uncertain";

export interface CommandOperation {
	id: OperationId;
	toolCallId: string;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	command: string;
	requestedCwd?: string;
	resolvedCwd?: string;
	timeoutMs: number;
	status: CommandOperationStatus;
	queueDeadlineAt: number;
	executionContext?: SshTargetSnapshot;
	guardRevision?: number;
	matchedGuardRuleId?: string;
	exitCode?: number;
	exitSignal?: string;
	failure?: SshFailure;
	outputBytes: number;
	outputTruncated: boolean;
	createdAt: number;
	enqueuedAt?: number;
	claimedAt?: number;
	startedAt?: number;
	finishedAt?: number;
}

export type OperationEventData =
	| { status: CommandOperationStatus }
	| { chunk: string }
	| { exitCode?: number; exitSignal?: string }
	| { limitBytes: number };

export type OperationEventType = "status" | "stdout" | "stderr" | "exit" | "output_truncated";

export interface OperationEvent {
	operationId: OperationId;
	sequence: number;
	timestamp: number;
	type: OperationEventType;
	data: OperationEventData;
}

export const ACTIVE_COMMAND_OPERATION_STATUSES: readonly CommandOperationStatus[] = [
	"queued",
	"dispatching",
	"running",
];
