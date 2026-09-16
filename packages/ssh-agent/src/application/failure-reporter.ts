import { failureIdentity } from "../domain/errors.ts";

export { failureIdentity, linkFailureIdentity } from "../domain/errors.ts";

export interface FailureScope {
	stage: string;
	runId?: string;
	sessionId?: string;
	requestId?: string;
	requestAttemptId?: string;
	rootErrorId?: string;
}

export function redactFailureText(text: string): string {
	return text
		.replace(/\b(?:set-cookie|cookie|authorization|proxy-authorization)\s*:[^\r\n]*/gi, "[REDACTED HEADER]")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
		.replace(
			/((?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|secret)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'&]+)/gi,
			"$1[REDACTED]",
		)
		.replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
			try {
				const url = new URL(value);
				url.username = "";
				url.password = "";
				url.search = "";
				url.hash = "";
				return url.toString();
			} catch {
				return "[URL]";
			}
		})
		.slice(0, 16000);
}

function diagnostic(error: unknown, seen = new Set<unknown>(), depth = 0): unknown {
	if (depth > 8 || seen.has(error)) return "[truncated cause]";
	seen.add(error);
	if (error instanceof Error)
		return {
			name: error.name,
			code:
				"code" in error && (typeof error.code === "string" || typeof error.code === "number")
					? redactFailureText(String(error.code))
					: undefined,
			status: "status" in error && typeof error.status === "number" ? error.status : undefined,
			message: redactFailureText(error.message),
			stack: error.stack ? redactFailureText(error.stack) : undefined,
			cause: error.cause === undefined ? undefined : diagnostic(error.cause, seen, depth + 1),
			...(error instanceof AggregateError
				? { errors: error.errors.slice(0, 16).map((value: unknown) => diagnostic(value, seen, depth + 1)) }
				: {}),
		};
	if (error !== null && typeof error === "object" && "errorMessage" in error) {
		return {
			message: typeof error.errorMessage === "string" ? redactFailureText(error.errorMessage) : undefined,
			provider: "provider" in error && typeof error.provider === "string" ? error.provider : undefined,
			model: "model" in error && typeof error.model === "string" ? error.model : undefined,
		};
	}
	return typeof error === "string" ? redactFailureText(error) : "Non-Error failure";
}

export function reportFailure(error: unknown, scope: FailureScope): { errorId: string } {
	const identity = failureIdentity(error);
	try {
		if (identity.reported) {
			if (scope.rootErrorId && identity.rootErrorId !== scope.rootErrorId) {
				identity.rootErrorId = scope.rootErrorId;
				console.warn("SSH Agent failure linked", { ...scope, errorId: identity.errorId });
			}
			return { errorId: identity.errorId };
		}
		identity.reported = true;
		identity.rootErrorId = scope.rootErrorId;
		console.error("SSH Agent failure", { ...scope, errorId: identity.errorId, error: diagnostic(error) });
	} catch {
		try {
			process.stderr.write(`SSH Agent diagnostic failed: ${identity.errorId}\n`);
		} catch {
			/* No remaining diagnostic sink. */
		}
	}
	return { errorId: identity.errorId };
}
