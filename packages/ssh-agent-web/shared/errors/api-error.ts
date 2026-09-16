export type ApiErrorCode =
	| "validation_error"
	| "origin_not_allowed"
	| "not_found"
	| "revision_conflict"
	| "active_credential_in_use"
	| "workspace_has_sessions"
	| "payload_too_large"
	| "secret_store_failed"
	| "internal_error"
	| string;

export class ApiError extends Error {
	readonly status: number;
	readonly code: ApiErrorCode;
	readonly field?: string;
	readonly details?: Record<string, unknown>;

	constructor(status: number, code: ApiErrorCode, message: string, field?: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.field = field;
		this.details = details;
	}
}

export function errorMessage(error: unknown, fallbackMessage = "Request failed. Please try again."): string {
	if (error instanceof ApiError) return error.message.trim() || fallbackMessage;
	return fallbackMessage;
}
