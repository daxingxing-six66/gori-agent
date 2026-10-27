import { getSupportedThinkingLevels, type Model, type OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CHATGPT_PROVIDER_ID, CHATGPT_RESOURCE } from "../src/domain/chatgpt.ts";
import { ChatGptCapabilityCatalog } from "../src/infrastructure/chatgpt/chatgpt-model-capabilities.ts";
import { chatGptModelDocumentationUrl, parseChatGptModelDocumentation } from "../src/infrastructure/chatgpt/chatgpt-model-metadata.ts";
import { ChatGptOAuthClient } from "../src/infrastructure/chatgpt/chatgpt-oauth.ts";
import { chatGptProvider, parseChatGptModels } from "../src/infrastructure/chatgpt/chatgpt-provider.ts";

const id = "gpt-future-model";
const url = `https://developers.openai.com/api/docs/models/${id}.md`;
const documentation = (context = "2,000,000", supported = "`low`, `high`, and `max`") => `# Future model
Model ID: \`${id}\`
\`reasoning.effort\` supports ${supported}.
## Model details
- Input modalities: text, image
- ${context} context window
- 200,000 max output tokens
## Pricing
Unrelated prose must not become configuration.
`;
const visible = (slug = id) => ({ slug, display_name: "Account model name", visibility: "list" });
const account = () => ({ models: [visible(), { ...visible("hidden"), visibility: "hidden" }] });
const baseline: Model<"openai-responses"> = {
	id, name: "Old baseline", api: "openai-responses", provider: "openai", baseUrl: "https://wrong.example",
	reasoning: true, input: ["text"], contextWindow: 400_000, maxTokens: 8_000,
	cost: { input: 3, output: 5, cacheRead: 1, cacheWrite: 1 },
};

describe("ChatGPT official model metadata", () => {
	it("learns a new exact model's window and efforts without adding a model-name branch", () => {
		const parsed = parseChatGptModelDocumentation(id, documentation())!;
		expect(parsed).toMatchObject({ contextWindow: 2_000_000, maxTokens: 200_000, input: ["text", "image"], reasoning: true });
		expect(getSupportedThinkingLevels({ ...baseline, ...parsed })).toEqual(["low", "high", "max"]);
	});
	it("maps an explicitly supported none to off and rejects unspecified levels", () => {
		const parsed = parseChatGptModelDocumentation(id, documentation("2,000,000", "`none` and `medium`"))!;
		expect(getSupportedThinkingLevels({ ...baseline, ...parsed })).toEqual(["off", "medium"]);
		expect(parsed.thinkingLevelMap).toMatchObject({ off: "none", low: null, high: null, max: null });
	});
	it("accepts a multiline effort declaration and an explicitly listed snapshot only", () => {
		const markdown = documentation("2,000,000", "`low`,\n`medium` (default), and `high`") + `
## Snapshots
- \`${id}-2026-10-27\`
## Other
- \`${id}-not-a-snapshot\`
`;
		expect(parseChatGptModelDocumentation(`${id}-2026-10-27`, markdown)?.contextWindow).toBe(2_000_000);
		expect(parseChatGptModelDocumentation(`${id}-not-a-snapshot`, markdown)).toBeUndefined();
		expect(parseChatGptModelDocumentation("gpt-other", markdown)).toBeUndefined();
	});
	it.each([
		(markdown: string) => markdown.replace(id, "gpt-other"),
		(markdown: string) => markdown.replace("2,000,000", "2,00,000"),
		(markdown: string) => markdown.replace("2,000,000", "0"),
		(markdown: string) => markdown.replace("2,000,000", "9007199254740992"),
		(markdown: string) => markdown.replace("200,000 max output", "3,000,000 max output"),
		(markdown: string) => markdown.replace("text, image", "image"),
		(markdown: string) => markdown.replace("text, image", "text, audio"),
		(markdown: string) => markdown.replace("`max`", "`unknown-effort`"),
		(markdown: string) => markdown.replace("`reasoning.effort` supports", "Something else supports"),
	])("does not adopt incomplete, mismatched or invalid capabilities: %s", (mutate) => {
		expect(parseChatGptModelDocumentation(id, mutate(documentation()))).toBeUndefined();
	});
	it("requires an explicit non-reasoning declaration rather than treating missing fields as unsupported", () => {
		const markdown = documentation().replace(/^`reasoning\.effort`.*$/m, "- Reasoning tokens: Not supported");
		expect(parseChatGptModelDocumentation(id, markdown)).toMatchObject({ reasoning: false });
		expect(parseChatGptModelDocumentation(id, markdown.replace("- Reasoning tokens: Not supported", ""))).toBeUndefined();
	});
	it.each(["../../secret", "gpt-../../secret", "gpt-foo?redirect=evil", "https://elsewhere.test", "gpt-foo/bar"])("does not form a URL for %s", (slug) => {
		expect(chatGptModelDocumentationUrl(slug)).toBeUndefined();
	});
});

describe("ChatGPT capability refresh", () => {
	it("updates an existing model, keeps last successful capabilities on an outage, and recovers", async () => {
		let content = documentation(); let time = 10; let failed = false;
		const catalog = new ChatGptCapabilityCatalog(async () => failed ? new Response(null, { status: 503 }) : new Response(content), () => time);
		const first = (await catalog.refresh([id], new AbortController().signal)).get(id)!;
		expect(first).toMatchObject({ checkedAt: 10, stale: false, capabilities: { contextWindow: 2_000_000 } });
		time = 20; failed = true;
		expect((await catalog.refresh([id], new AbortController().signal)).get(id)).toMatchObject({ checkedAt: 10, stale: true });
		failed = false; content = documentation("3,000,000", "`medium` and `high`");
		const latest = (await catalog.refresh([id], new AbortController().signal)).get(id)!;
		expect(latest).toMatchObject({ checkedAt: 20, stale: false, capabilities: { contextWindow: 3_000_000 } });
		// A running model's earlier snapshot cannot change underneath it.
		expect(first.capabilities.contextWindow).toBe(2_000_000);
	});
	it("returns no invented capabilities for an unknown model or changed document format", async () => {
		const catalog = new ChatGptCapabilityCatalog(async () => new Response("<html>Unrecognized format</html>"));
		expect((await catalog.refresh([id], new AbortController().signal)).size).toBe(0);
	});
	it("rejects oversized bodies with or without content-length", async () => {
		for (const headers of [undefined, { "content-length": "300000" }]) {
			const catalog = new ChatGptCapabilityCatalog(async () => new Response(documentation() + " ".repeat(300_000), { headers }));
			expect((await catalog.refresh([id], new AbortController().signal)).size).toBe(0);
		}
	});
	it("propagates caller cancellation and does not publish an aborted result", async () => {
		const controller = new AbortController();
		let aborted = false;
		const catalog = new ChatGptCapabilityCatalog(async () => {
			if (aborted) return new Response(null, { status: 503 });
			controller.abort(); aborted = true; return new Response(documentation());
		});
		await expect(catalog.refresh([id], controller.signal)).rejects.toThrow();
		expect((await catalog.refresh([id], new AbortController().signal)).size).toBe(0);
	});
	it("cancels a stalled documentation body without blocking account model refresh", async () => {
		const controller = new AbortController();
		let started: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		let cancelled = false;
		const catalog = new ChatGptCapabilityCatalog(async () => new Response(new ReadableStream({
			pull() { started(); }, cancel() { cancelled = true; },
		})));
		const pending = catalog.refresh([id], controller.signal);
		await ready; controller.abort();
		await expect(pending).rejects.toThrow();
		expect(cancelled).toBe(true);
	});
	it("does not let an older refresh overwrite a newer successful snapshot", async () => {
		let finish: (value: Response) => void = () => undefined;
		let calls = 0;
		const catalog = new ChatGptCapabilityCatalog(async () => {
			calls++;
			if (calls === 1) return new Promise<Response>((resolve) => { finish = resolve; });
			return calls === 2 ? new Response(documentation("3,000,000")) : new Response(null, { status: 503 });
		});
		const old = catalog.refresh([id], new AbortController().signal);
		await catalog.refresh([id], new AbortController().signal);
		finish(new Response(documentation())); await old;
		expect((await catalog.refresh([id], new AbortController().signal)).get(id)?.capabilities.contextWindow).toBe(3_000_000);
	});
	it("does not authorize models from the public metadata or inherit their prices and endpoints", async () => {
		const catalog = new ChatGptCapabilityCatalog(async () => new Response(documentation()));
		const snapshots = await catalog.refresh([id], new AbortController().signal);
		const models = parseChatGptModels(account(), [baseline, { ...baseline, id: "not-entitled" }], snapshots);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ id, name: "Account model name", provider: CHATGPT_PROVIDER_ID, baseUrl: CHATGPT_RESOURCE,
			contextWindow: 2_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			chatGptCapabilities: { source: "official-docs", stale: false, url } });
		expect(getSupportedThinkingLevels(models[0]!)).toEqual(["low", "high", "max"]);
	});
	it("marks conservative local fallback and the bundled offline values as such", () => {
		const models = parseChatGptModels({ models: [visible(), visible("gpt-6-sol")] }, []);
		expect(models[0]?.chatGptCapabilities.source).toBe("fallback");
		expect(models[1]?.chatGptCapabilities.source).toBe("bundled");
		expect(parseChatGptModels(account(), [baseline])[0]?.chatGptCapabilities.source).toBe("baseline");
	});
	it("wires account discovery to capability refresh, preserves ordering and never sends OAuth to docs", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const mockFetch: typeof fetch = async (input, init) => {
			const requestUrl = String(input); calls.push({ url: requestUrl, init });
			return requestUrl === `${CHATGPT_RESOURCE}/models` ? Response.json(account()) : new Response(documentation());
		};
		const provider = chatGptProvider({ oauth: new ChatGptOAuthClient(mockFetch), baseline: [], fetch: mockFetch });
		const credential: OAuthCredential = { type: "oauth", access: "private-access", refresh: "private-refresh", expires: Date.now() + 60_000,
			clientId: "test", subject: "subject", issuer: "https://auth.openai.com", email: "test@example.test", idToken: "id-token",
			scopes: ["chatgpt.tokens.use.direct", "resource.invoke"] };
		await provider.refreshModels!({ credential, allowNetwork: true, signal: new AbortController().signal,
			publish: async (publication) => { publication.update?.(); return true; } });
		expect(provider.getModels().map((model) => model.id)).toEqual([id]);
		expect(provider.getModels()[0]?.contextWindow).toBe(2_000_000);
		expect(calls).toHaveLength(2);
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer private-access");
		expect(calls[1]?.url).toBe(url);
		expect(new Headers(calls[1]?.init?.headers).has("authorization")).toBe(false);
		expect(calls[1]?.init?.redirect).toBe("error");
	});
});
