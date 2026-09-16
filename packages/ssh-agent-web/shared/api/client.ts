import { ApiError } from "@/shared/errors/api-error";
import { parseSupportedLocale, type SupportedLocale } from "@/features/i18n/model/locale";

interface ApiErrorPayload {
	error?: {
		code?: unknown;
		message?: unknown;
		field?: unknown;
		details?: unknown;
	};
}

interface ApiRequestOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	body?: unknown;
	signal?: AbortSignal;
}

interface ApiUploadOptions {
	contentType: string;
	signal?: AbortSignal;
}

const configuredBaseUrl =
	process.env.NEXT_PUBLIC_SSH_AGENT_API_BASE_URL?.replace(/\/$/, "") ??
	(process.env.NODE_ENV === "development" ? "http://127.0.0.1:3001" : "");

export function apiUrl(path: string): string {
	return `${configuredBaseUrl}${path}`;
}

export function apiUrlWithLocale(path: string, locale: SupportedLocale): string {
	const url = new URL(path, "http://ssh-agent.local");
	url.searchParams.set("locale", locale);
	return apiUrl(`${url.pathname}${url.search}`);
}

export function requestLocale(): SupportedLocale {
	if (typeof document === "undefined") return "zh-CN";
	return parseSupportedLocale(document.documentElement.dataset.locale) ??
		parseSupportedLocale(document.documentElement.lang) ??
		"zh-CN";
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
	const response = await fetch(apiUrl(path), {
		method: options.method ?? "GET",
		headers: {
			accept: "application/json",
			"accept-language": requestLocale(),
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal,
		cache: "no-store",
	});

	if (!response.ok) throw await parseApiError(response);
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export async function apiUpload<T>(path: string, body: BodyInit, options: ApiUploadOptions): Promise<T> {
	const response = await fetch(apiUrl(path), {
		method: "POST",
		headers: {
			accept: "application/json",
			"accept-language": requestLocale(),
			"content-type": options.contentType,
		},
		body,
		signal: options.signal,
		cache: "no-store",
	});

	if (!response.ok) throw await parseApiError(response);
	return (await response.json()) as T;
}

async function parseApiError(response: Response): Promise<ApiError> {
	let payload: ApiErrorPayload = {};
	try {
		payload = (await response.json()) as ApiErrorPayload;
	} catch {
		return new ApiError(response.status, "internal_error", `Request failed with HTTP ${response.status}`);
	}
	const code = typeof payload.error?.code === "string" ? payload.error.code : "internal_error";
	const message =
		typeof payload.error?.message === "string" ? payload.error.message : `Request failed with HTTP ${response.status}`;
	const field = typeof payload.error?.field === "string" ? payload.error.field : undefined;
	const details = payload.error?.details !== null && typeof payload.error?.details === "object"
		? payload.error.details as Record<string, unknown>
		: undefined;
	return new ApiError(response.status, code, message, field, details);
}
