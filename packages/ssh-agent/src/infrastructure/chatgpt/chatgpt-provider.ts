import { createProvider, type Model, type OAuthCredential, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { CHATGPT_PROVIDER_ID, CHATGPT_RESOURCE, isChatGptCredential } from "../../domain/chatgpt.ts";
import type { ChatGptOAuthClient } from "./chatgpt-oauth.ts";
import { chatGptResponsesApi } from "./chatgpt-responses.ts";
import { chatGptCapabilityCatalog, type ChatGptCapabilitySnapshot } from "./chatgpt-model-capabilities.ts";

// Exact model capabilities supplement models newer than the bundled OpenAI baseline.
// https://developers.openai.com/api/docs/models/gpt-6-sol (and the other exact model pages)
const GPT6_EFFORTS = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } satisfies ThinkingLevelMap;
const GPT6_THINKING_LEVEL_MAPS: ReadonlyMap<string, ThinkingLevelMap> = new Map([
	["gpt-6.1-sol", { ...GPT6_EFFORTS, off: null }],
	["gpt-6-astra", { ...GPT6_EFFORTS, off: null }],
	["gpt-6-sol", { ...GPT6_EFFORTS, off: "none" }],
	["gpt-6-luna", { ...GPT6_EFFORTS, off: "none" }],
]);

export interface ChatGptModel extends Model<"openai-responses"> {
	/** Local provenance only; not a request field or an account entitlement. */
	chatGptCapabilities: {
		source: "official-docs" | "baseline" | "bundled" | "fallback";
		checkedAt: number | null;
		stale: boolean;
		url?: string;
	};
}

export function chatGptProvider(options: { oauth: ChatGptOAuthClient; baseline: readonly Model<"openai-responses">[]; fetch?: typeof fetch }): Provider<"openai-responses"> {
	const fetchModels = options.fetch ?? fetch;
	const capabilities = chatGptCapabilityCatalog(fetchModels);
	const provider = createProvider<"openai-responses">({
		id: CHATGPT_PROVIDER_ID, name: "ChatGPT", baseUrl: CHATGPT_RESOURCE,
		auth: { oauth: {
			name: "ChatGPT Plus / Pro", isSubscription: true, loginLabel: "Continue with ChatGPT",
			login: async () => { throw new Error("Connect ChatGPT from Gori Provider settings"); },
			refresh: (credential, signal) => {
				if (!isChatGptCredential(credential)) throw new Error("ChatGPT registration is invalid; sign in again");
				return options.oauth.refresh(credential, signal);
			},
			toAuth: async (credential: OAuthCredential) => {
				if (!isChatGptCredential(credential) || !credential.scopes.includes("chatgpt.tokens.use.direct")) throw new Error("Authorize ChatGPT plan usage in Provider settings");
				return { apiKey: credential.access, baseUrl: CHATGPT_RESOURCE };
			},
		} },
		models: [],
		fetchModels: async ({ credential, signal }) => {
			if (credential?.type !== "oauth" || !isChatGptCredential(credential)) throw new Error("ChatGPT is not connected");
			const response = await fetchModels(`${CHATGPT_RESOURCE}/models`, {
				signal, redirect: "error", headers: { authorization: `Bearer ${credential.access}`, accept: "application/json" },
			});
			if (!response.ok) throw new Error(`ChatGPT model discovery failed (HTTP ${response.status})`);
			const value: unknown = await response.json();
			// Validate entitlements first; public documentation can only enrich these exact models.
			const discovered = parseChatGptModels(value, options.baseline);
			const snapshots = await capabilities.refresh(discovered.map((model) => model.id), signal);
			return parseChatGptModels(value, options.baseline, snapshots);
		},
		api: chatGptResponsesApi(),
	});
	const refresh = provider.refreshModels!;
	// An earlier account's catalog must never be restored after an account switch.
	provider.refreshModels = (context) => refresh({ ...context, stored: undefined });
	return provider;
}

export function parseChatGptModels(value: unknown, baseline: readonly Model<"openai-responses">[],
	snapshots: ReadonlyMap<string, ChatGptCapabilitySnapshot> = new Map()): ChatGptModel[] {
	if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) throw new Error("Invalid ChatGPT model catalog");
	const seen = new Set<string>();
	return value.models.flatMap((entry: unknown) => {
		if (!entry || typeof entry !== "object" || !("visibility" in entry) || entry.visibility !== "list") return [];
		if (!("slug" in entry) || typeof entry.slug !== "string" || !entry.slug.trim() ||
			!("display_name" in entry) || typeof entry.display_name !== "string" || !entry.display_name.trim() || seen.has(entry.slug)) throw new Error("Invalid ChatGPT model entry");
		seen.add(entry.slug);
		const known = baseline.find((model) => model.id === entry.slug);
		const snapshot = snapshots.get(entry.slug);
		const thinkingLevelMap = GPT6_THINKING_LEVEL_MAPS.get(entry.slug);
		const documented = thinkingLevelMap ? {
			reasoning: true, thinkingLevelMap: { ...thinkingLevelMap },
			input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000,
		} satisfies Pick<Model<"openai-responses">, "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens"> : undefined;
		// Discovery alone determines visibility. Fresh/cached official facts enrich exact matches;
		// the baseline and bundled values only bootstrap offline operation. Unknowns stay conservative.
		return [{
			...(known ?? documented ?? { reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096 }),
			...(snapshot ? structuredClone(snapshot.capabilities) : {}),
			chatGptCapabilities: snapshot ? { source: "official-docs", checkedAt: snapshot.checkedAt, stale: snapshot.stale, url: snapshot.url } :
				{ source: known ? "baseline" : documented ? "bundled" : "fallback", checkedAt: null, stale: false },
			id: entry.slug, name: entry.display_name, provider: CHATGPT_PROVIDER_ID,
			api: "openai-responses", baseUrl: CHATGPT_RESOURCE,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Support the flag so ordinary functions emit strict: false instead of relying on Responses defaults.
			compat: { supportsStrictMode: true, supportsDeveloperRole: true, supportsLongCacheRetention: false, supportsAdditionalTools: false, supportsToolSearch: false },
		} satisfies ChatGptModel];
	});
}
