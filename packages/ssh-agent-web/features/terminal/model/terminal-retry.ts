import { ApiError } from "@/shared/errors/api-error";

export function shouldRetryTerminalConnection(error: unknown): boolean {
	return !(error instanceof ApiError && error.retryable === false);
}
