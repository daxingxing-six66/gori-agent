import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ChatRun } from "../domain/chat.ts";
import { type BackendMessageDescriptor, backendMessage } from "../i18n/message.ts";

export interface ProviderFailure {
	readonly providerId: string;
	readonly modelId: string;
	readonly upstreamStatus?: number;
	readonly upstreamCode?: string;
	readonly reason: string;
	readonly retryable: boolean;
}

export type ProviderFailureMessage = AssistantMessage & {
	providerFailure?: ProviderFailure;
	failure?: NonNullable<ChatRun["failure"]>;
	errorMessageDescriptor?: BackendMessageDescriptor;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeReason(value: string): string | undefined {
	if (
		/<(?:!doctype|html|head|body|script|title|h[1-6])\b/i.test(value) ||
		/^(?:TypeError|ReferenceError|SyntaxError):/.test(value)
	)
		return undefined;
	const text = value
		.split(/\n\s*at\s/)[0]!
		.replace(/\b(?:set-cookie|cookie|authorization|proxy-authorization)\s*:[^\r\n]*/gi, "[REDACTED HEADER]")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
		.replace(
			/((?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|authorization|password|secret|cookie)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'&]+)/gi,
			"$1[REDACTED]",
		)
		.replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
			try {
				const parsed = new URL(url);
				parsed.username = "";
				parsed.password = "";
				parsed.search = "";
				parsed.hash = "";
				return parsed.toString();
			} catch {
				return "[URL]";
			}
		})
		.trim();
	return text ? text.slice(0, 2000) : undefined;
}

/** Only a terminal Provider response may expose unclassified plain text. */
export function normalizeProviderFailure(
	model: Model<Api>,
	value: unknown,
	source: "exception" | "response" = "exception",
): ProviderFailure | undefined {
	const outer = record(value);
	const cause = record(outer?.cause);
	const transportCode = String(outer?.code ?? cause?.code ?? "");
	const transport =
		/^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
			transportCode,
		) || /^(?:APIConnectionError|APIConnectionTimeoutError|TimeoutError)$/.test(String(outer?.name));
	let status = Number(outer?.status ?? outer?.statusCode);
	let text = typeof value === "string" ? value : typeof outer?.message === "string" ? outer.message : "";
	const prefixStatus = text.match(/^(?:.*?API error\s*\(|(?:HTTP\s+)?)([45]\d\d)(?:\)|\s*:|\s+status code)/i);
	if (!Number.isInteger(status) && prefixStatus) status = Number(prefixStatus[1]);
	if (source === "exception" && !transport && !(status >= 400 && status <= 599)) return undefined;
	if (value instanceof TypeError && !transport) return undefined;
	const structured = record(outer?.error);
	let payload = structured ?? outer;
	const start = text.indexOf("{");
	if (typeof structured?.message !== "string" && start >= 0) {
		try {
			const parsed = record(JSON.parse(text.slice(start)));
			if (parsed) payload = record(parsed.error) ?? parsed;
			if (typeof payload?.message !== "string") return undefined;
		} catch {
			return undefined;
		}
	}
	const code =
		typeof payload?.code === "string" ? payload.code : typeof payload?.type === "string" ? payload.type : undefined;
	if (typeof payload?.message === "string") text = payload.message;
	if (transport)
		text = /TIMEDOUT|TIMEOUT|Timeout/.test(`${transportCode} ${outer?.name}`)
			? "The model service request timed out"
			: "Could not connect to the model service";
	const reason = safeReason(text);
	if (!reason) return undefined;
	const permanent =
		/insufficient[_ ]quota|quota.{0,40}exhausted|credit|balance|billing|payment|required.*recharg|余额|额度.*(?:不足|耗尽)|unsupported_country|(?:country|region|territory).*not supported|invalid[_ ](?:param|api)|authentication|permission|max_tokens.*(?:must|limit|exceed|large)/i.test(
			`${code ?? ""} ${reason}`,
		);
	return {
		providerId: model.provider,
		modelId: model.id,
		reason,
		...(status >= 400 && status <= 599 ? { upstreamStatus: status } : {}),
		...(code ? { upstreamCode: code } : {}),
		retryable: !permanent && (transport || status === 429 || status === 408 || (status >= 500 && status <= 599)),
	};
}

export function providerFailureDescriptor(
	failure: ProviderFailure,
	scene: "chat" | "compaction" | "removed" = "chat",
): BackendMessageDescriptor {
	if (scene === "chat" && /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i.test(failure.reason))
		return backendMessage("provider.empty_error_body", { status: failure.upstreamStatus ?? 400 });
	const reason = `${failure.reason}${failure.upstreamStatus ? ` (HTTP ${failure.upstreamStatus})` : ""}`;
	return backendMessage(
		scene === "compaction"
			? "provider.compaction_failed"
			: scene === "removed"
				? "provider.model_removed"
				: "provider.request_failed",
		{ reason },
	);
}

export function isUnsupportedSelectedModel(message: AssistantMessage, providerId: string, modelId: string): boolean {
	if (message.role !== "assistant" || message.stopReason !== "error") return false;
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "pi_messages_response_failure") continue;
		if (diagnostic.details?.provider !== providerId || diagnostic.details.model !== modelId) continue;
		if (isUnsupportedModelError(diagnostic.details.error, modelId)) return true;
		if (
			typeof diagnostic.details.body === "string" &&
			isUnsupportedModelErrorBody(diagnostic.details.body, modelId)
		) {
			return true;
		}
	}
	return message.errorMessage !== undefined && isUnsupportedModelErrorBody(message.errorMessage, modelId);
}

function isUnsupportedModelErrorBody(body: string, modelId: string): boolean {
	const start = body.indexOf("{");
	if (start < 0) return false;
	try {
		return isUnsupportedModelError(JSON.parse(body.slice(start)) as unknown, modelId);
	} catch {
		return false;
	}
}

function isUnsupportedModelError(value: unknown, modelId: string): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const error = value as Record<string, unknown>;
	return error.type === "ModelError" && error.message === `Model ${modelId} is not supported`;
}
