import type { CustomLlmProviderApi } from "@/features/llm-provider/model/llm-provider";

export interface DiscoveredCustomLlmModel {
	id: string;
	name: string;
}

interface ModelDiscoveryResponse {
	data?: unknown;
	models?: unknown;
}

export type CustomProviderModelDiscoveryErrorCode =
	| "invalid_endpoint"
	| "api_key_required"
	| "request_failed"
	| "invalid_response";

export class CustomProviderModelDiscoveryError extends Error {
	readonly code: CustomProviderModelDiscoveryErrorCode;
	readonly status?: number;

	constructor(code: CustomProviderModelDiscoveryErrorCode, status?: number) {
		super(code);
		this.name = "CustomProviderModelDiscoveryError";
		this.code = code;
		this.status = status;
	}
}

export function defaultModelsEndpoint(baseUrl: string): string {
	try {
		const url = new URL(baseUrl.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		url.pathname = "/models";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return "";
	}
}

function modelItem(value: unknown): DiscoveredCustomLlmModel | null {
	if (value === null || typeof value !== "object") return null;
	const item = value as Record<string, unknown>;
	const rawId = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
	const id = rawId.replace(/^models\//, "").trim();
	if (!id) return null;
	const name = typeof item.displayName === "string"
		? item.displayName.trim()
		: typeof item.name === "string" && !item.name.startsWith("models/")
			? item.name.trim()
			: id;
	return { id, name: name || id };
}

export async function discoverCustomProviderModels({
	endpoint,
	api,
	apiKey,
	signal,
}: {
	endpoint: string;
	api: CustomLlmProviderApi;
	apiKey: string;
	signal?: AbortSignal;
}): Promise<DiscoveredCustomLlmModel[]> {
	let url: URL;
	try {
		url = new URL(endpoint.trim());
	} catch {
		throw new CustomProviderModelDiscoveryError("invalid_endpoint");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new CustomProviderModelDiscoveryError("invalid_endpoint");
	const normalizedApiKey = apiKey.trim();
	if (!normalizedApiKey) throw new CustomProviderModelDiscoveryError("api_key_required");
	const headers: Record<string, string> = { accept: "application/json" };
	if (api === "anthropic-messages") {
		headers["x-api-key"] = normalizedApiKey;
		headers["anthropic-version"] = "2023-06-01";
	} else if (api === "google-generative-ai") {
		headers["x-goog-api-key"] = normalizedApiKey;
	} else {
		headers.authorization = `Bearer ${normalizedApiKey}`;
	}
	const response = await fetch(url, { method: "GET", headers, signal, cache: "no-store" });
	if (!response.ok) throw new CustomProviderModelDiscoveryError("request_failed", response.status);
	const payload = await response.json() as ModelDiscoveryResponse;
	const values = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null;
	if (values === null) throw new CustomProviderModelDiscoveryError("invalid_response");
	const uniqueModels = new Map<string, DiscoveredCustomLlmModel>();
	for (const value of values) {
		const model = modelItem(value);
		if (model && !uniqueModels.has(model.id)) uniqueModels.set(model.id, model);
	}
	return [...uniqueModels.values()];
}
