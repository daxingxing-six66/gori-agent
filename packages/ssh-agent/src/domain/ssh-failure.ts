import type { BackendMessageKey, BackendMessageValues } from "../i18n/message.ts";
import { failureIdentity, linkFailureIdentity } from "./errors.ts";
import type { OperationId, SessionId, WorkspaceId } from "./ids.ts";

export type SshFailureCategory =
	| "request"
	| "queue"
	| "guard"
	| "workspace"
	| "host_trust"
	| "connection"
	| "authentication"
	| "channel"
	| "execution"
	| "persistence"
	| "internal";

export type SshFailurePhase =
	| "validate"
	| "enqueue"
	| "dispatch"
	| "guard_check"
	| "resolve_target"
	| "connect"
	| "verify_host"
	| "authenticate"
	| "acquire_channel"
	| "execute"
	| "upload"
	| "commit"
	| "cancel"
	| "persist";

export type SshFailureCode =
	| "invalid_request"
	| "session_not_found"
	| "workspace_not_found"
	| "credential_not_found"
	| "workspace_unavailable"
	| "queue_timeout"
	| "queue_closed"
	| "cancelled_before_dispatch"
	| "guard_blocked"
	| "guard_configuration_invalid"
	| "host_key_untrusted"
	| "host_key_mismatch"
	| "host_key_algorithm_unsupported"
	| "dns_lookup_failed"
	| "connection_refused"
	| "connection_timeout"
	| "network_unreachable"
	| "transport_lost"
	| "keepalive_timeout"
	| "connection_retry_exhausted"
	| "connection_invalidated"
	| "connection_pool_closed"
	| "authentication_failed"
	| "authentication_method_unsupported"
	| "invalid_private_key"
	| "private_key_passphrase_required"
	| "private_key_passphrase_invalid"
	| "credential_secret_unavailable"
	| "channel_acquire_timeout"
	| "channel_open_failed"
	| "channel_limit_reached"
	| "channel_closed"
	| "sftp_channel_open_failed"
	| "upload_failed"
	| "upload_commit_failed"
	| "upload_cancelled"
	| "upload_result_uncertain"
	| "remote_exit_non_zero"
	| "execution_timeout"
	| "execution_cancelled"
	| "execution_result_uncertain"
	| "exit_signal_received"
	| "output_limit_exceeded"
	| "operation_persistence_failed"
	| "operation_event_persistence_failed"
	| "service_restarted_before_dispatch"
	| "unexpected_internal_error";

export type SshSafeDetail = string | number | boolean;

export interface SshFailure {
	code: SshFailureCode;
	category: SshFailureCategory;
	phase: SshFailurePhase;
	message: string;
	messageKey?: BackendMessageKey;
	messageValues?: BackendMessageValues;
	retryable: boolean;
	operationId?: OperationId;
	sessionId?: SessionId;
	workspaceId?: WorkspaceId;
	safeDetails?: Record<string, SshSafeDetail>;
}

export class SshAgentError extends Error {
	readonly failure: SshFailure;

	constructor(failure: SshFailure, cause?: Error) {
		super(failure.message, cause === undefined ? undefined : { cause });
		this.name = "SshAgentError";
		this.failure = failure;
		linkFailureIdentity(this, cause ?? failure);
	}
}

export function normalizeSshFailure(error: unknown, fallback: Omit<SshFailure, "code" | "message">): SshFailure {
	if (error instanceof SshAgentError) return error.failure;
	return {
		...fallback,
		code: "unexpected_internal_error",
		message: "SSH Agent encountered an internal error",
		retryable: false,
		safeDetails: { errorId: failureIdentity(error).errorId },
	};
}
