import { randomUUID } from "node:crypto";

export type ManagementErrorCode =
	| "validation_error"
	| "not_found"
	| "revision_conflict"
	| "llm_provider_conflict"
	| "llm_provider_in_use"
	| "active_credential_in_use"
	| "workspace_has_sessions"
	| "session_has_active_operations"
	| "session_has_active_chat_run"
	| "session_has_active_attachment_upload"
	| "session_deletion_in_progress"
	| "session_work_dir_unavailable"
	| "host_key_mismatch"
	| "connection_failed"
	| "authentication_failed"
	| "secret_store_failed";

export class ManagementError extends Error {
	readonly code: ManagementErrorCode;
	readonly field?: string;

	constructor(code: ManagementErrorCode, message: string, field?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ManagementError";
		this.code = code;
		this.field = field;
	}
}

const identities = new WeakMap<object, { errorId: string; reported?: boolean; rootErrorId?: string }>();

/** Preserve identity across wrappers without serializing the original exception. */
export function failureIdentity(error: unknown): { errorId: string; reported?: boolean; rootErrorId?: string } {
	if (error !== null && typeof error === "object") {
		const previous = identities.get(error);
		if (previous) return previous;
		const value = { errorId: randomUUID() };
		identities.set(error, value);
		return value;
	}
	return { errorId: randomUUID() };
}

export function linkFailureIdentity(wrapper: object, original: unknown): void {
	identities.set(wrapper, failureIdentity(original));
}
