import type { CustomLlmModel, CustomLlmProvider } from "../../domain/llm-provider.ts";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_MODELS = 2_000;
const MAX_PAGES = 20;

/** Discover IDs only. A compatible /models response is not authoritative model capability metadata. */
export async function discoverCustomLlmModels(
	provider: CustomLlmProvider,
	apiKey: string | undefined,
	signal: AbortSignal,
	request: typeof fetch = globalThis.fetch,
): Promise<CustomLlmModel[]> {
	const endpoint = new URL(provider.baseUrl);
	endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/models`;
	endpoint.hash = "";
	const headers: Record<string, string> = { accept: "application/json" };
	if (apiKey) {
		if (provider.api === "anthropic-messages") headers["x-api-key"] = apiKey;
		else if (provider.api === "google-generative-ai") headers["x-goog-api-key"] = apiKey;
		else headers.authorization = `Bearer ${apiKey}`;
	}
	if (provider.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	const existing = new Map(provider.models.map((model) => [model.id, model]));
	const discovered = new Map<string, CustomLlmModel>();
	const cursors = new Set<string>();
	for (let page = 0; page < MAX_PAGES; page++) {
		signal.throwIfAborted();
		// Never forward stored credentials to another location after a redirect.
		const response = await request(endpoint, { headers, signal, redirect: "error" });
		if (!response.ok) throw new Error("Model discovery request failed");
		const payload = await readJson(response);
		if (!isRecord(payload)) throw new Error("Invalid model discovery response");
		const values = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : undefined;
		if (!values) throw new Error("Invalid model discovery response");
		for (const value of values) {
			if (!isRecord(value)) throw new Error("Invalid model discovery entry");
			const rawId = typeof value.id === "string" ? value.id : value.name;
			const id = text(provider.api === "google-generative-ai" && typeof rawId === "string" ? rawId.replace(/^models\//, "") : rawId);
			const name = text(value.display_name ?? value.displayName ?? (typeof value.name === "string" && !value.name.startsWith("models/") ? value.name : id));
			if (!discovered.has(id)) discovered.set(id, existing.get(id) ?? {
				id, name, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			if (discovered.size > MAX_MODELS) throw new Error("Model discovery catalog too large");
		}
		const cursor = nextCursor(payload, provider.api);
		if (!cursor) return [...discovered.values()];
		if (cursors.has(cursor.value)) throw new Error("Repeated model discovery page");
		cursors.add(cursor.value);
		endpoint.searchParams.set(cursor.key, cursor.value);
	}
	throw new Error("Model discovery page limit exceeded");
}

function nextCursor(payload: Record<string, unknown>, api: CustomLlmProvider["api"]): { key: string; value: string } | undefined {
	if (api === "google-generative-ai" && payload.nextPageToken !== undefined && payload.nextPageToken !== "") {
		return { key: "pageToken", value: text(payload.nextPageToken, 4_096) };
	}
	if (payload.has_more === true && api === "anthropic-messages") return { key: "after_id", value: text(payload.last_id) };
	if (payload.has_more !== undefined && payload.has_more !== false) throw new Error("Invalid model discovery pagination");
	return undefined;
}

async function readJson(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("Empty model discovery response");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let json = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new Error("Model discovery response too large");
			json += decoder.decode(chunk.value, { stream: true });
		}
		return JSON.parse(json + decoder.decode());
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function text(value: unknown, maximum = 256): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error("Invalid model discovery text");
	return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
