import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomLlmProvider } from "../src/domain/llm-provider.ts";
import { createSqliteManagementBackend, type SqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

const backends: SqliteManagementBackend[] = [];
afterEach(async () => { await Promise.all(backends.splice(0).map((backend) => backend.close())); });

function setup(customFetch: typeof fetch = async () => Response.json({ data: [] }), catalogFetch: typeof fetch = async () => Response.json({ models: [] })) {
	const backend = createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: new Uint8Array(32).fill(4),
		llmModelsFactory: createTestLlmModels, customLlmModelFetch: customFetch, llmCatalogFetch: catalogFetch });
	backends.push(backend);
	return backend;
}

function providerInput() {
	return { id: "custom-local", name: "Local", baseUrl: "https://llm.example.test/v1", api: "openai-completions" as const,
		authMode: "none" as const, models: [{ id: "keep", name: "My model name", reasoning: true, input: ["text", "image"] as ("text" | "image")[],
			contextWindow: 100_000, maxTokens: 20_000, cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 2 } },
		{ id: "remove", name: "Removed", contextWindow: 10_000, maxTokens: 1_000 }] };
}

async function request(backend: SqliteManagementBackend, path: string, method = "GET", body?: unknown) {
	return backend.handleRequest(new Request(`http://localhost/api/llm/${path}`, { method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
}

async function createCustom(backend: SqliteManagementBackend, overrides: { api?: CustomLlmProvider["api"] } = {}) {
	expect((await request(backend, "custom-providers", "POST", { ...providerInput(), ...overrides })).status).toBe(201);
}

function pendingResponse() {
	let finish: (response: Response) => void = () => undefined;
	const response = new Promise<Response>((resolve) => { finish = resolve; });
	const fetcher = vi.fn<typeof fetch>(async () => response);
	return { fetcher, finish };
}

describe("manual provider model refresh", () => {
	it("refreshes a built-in catalog through the shared effective directory and returns only public model metadata", async () => {
		const catalogFetch = vi.fn<typeof fetch>(async () => Response.json({ models: [{ id: "new-model", name: "New model", api: "faux", baseUrl: "https://api.test",
			reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }));
		const backend = setup(undefined, catalogFetch);
		const response = await request(backend, "providers/anthropic/models", "POST");
		expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({ providerId: "anthropic", models: [{ id: "new-model", providerId: "anthropic" }] });
		expect(String(catalogFetch.mock.calls[0]![0])).toBe("https://pi.dev/api/models/providers/anthropic");
		expect(backend.llmModelCatalog.getModel("anthropic", "new-model")).toBeDefined();
		expect((await request(backend, "providers/unknown/models", "POST")).status).toBe(404);
	});

	it("keeps the previous built-in catalog and hides remote response text on failed manual refresh", async () => {
		const backend = setup(undefined, async () => new Response("sensitive-upstream-body", { status: 503 }));
		const response = await request(backend, "providers/anthropic/models", "POST");
		expect(response.status).toBe(502); expect(await response.text()).not.toContain("sensitive-upstream-body");
		expect(backend.llmModelCatalog.getModel("anthropic", "claude-sonnet-test")).toBeDefined();
	});

	it("discovers custom models at the configured base path, preserves known capabilities and replaces both persistent and effective catalogs", async () => {
		const customFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "new" }, { id: "keep" }, { id: "keep" }] }));
		const catalogFetch = vi.fn<typeof fetch>(); const backend = setup(customFetch, catalogFetch);
		await createCustom(backend);
		expect(backend.llmModelCatalog.removeModel("custom-local", "keep")).toBe(true);
		const response = await request(backend, "providers/custom-local/models", "POST");
		expect(response.status).toBe(200);
		const stored = await backend.api.getCustomLlmProvider("custom-local");
		expect(stored.revision).toBe(2); expect(stored.models.map((model) => model.id)).toEqual(["new", "keep"]);
		expect(stored.models[1]).toEqual(providerInput().models[0]);
		expect(stored.models[0]).toMatchObject({ id: "new", reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096 });
		expect(backend.llmModelCatalog.getModel("custom-local", "keep")).toBeDefined();
		expect(backend.llmModelCatalog.getModel("custom-local", "remove")).toBeUndefined();
		expect(String(customFetch.mock.calls[0]![0])).toBe("https://llm.example.test/v1/models");
		expect(new Headers(customFetch.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
		expect(customFetch.mock.calls[0]![1]?.redirect).toBe("error");
		expect(catalogFetch).not.toHaveBeenCalled();
	});

	it.each(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const)("uses the stored key privately with %s model discovery", async (api) => {
		const customFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "keep" }] }));
		const backend = setup(customFetch);
		expect((await request(backend, "custom-providers", "POST", { ...providerInput(), api, authMode: "api_key", credential: { type: "api_key", apiKey: "stored-secret" } })).status).toBe(201);
		const response = await request(backend, "providers/custom-local/models", "POST");
		expect(response.status).toBe(200); expect(await response.text()).not.toContain("stored-secret");
		const headers = new Headers(customFetch.mock.calls[0]![1]?.headers);
		expect(headers.get(api === "anthropic-messages" ? "x-api-key" : api === "google-generative-ai" ? "x-goog-api-key" : "authorization"))
			.toBe(api.startsWith("openai") ? "Bearer stored-secret" : "stored-secret");
		if (api === "anthropic-messages") expect(headers.get("anthropic-version")).toBe("2023-06-01");
	});

	it("fails without fetching when a custom API key is missing", async () => {
		const customFetch = vi.fn<typeof fetch>(); const backend = setup(customFetch);
		expect((await request(backend, "custom-providers", "POST", { ...providerInput(), authMode: "api_key" })).status).toBe(201);
		const response = await request(backend, "providers/custom-local/models", "POST");
		expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "llm_provider_not_configured" } });
		expect(customFetch).not.toHaveBeenCalled();
	});

	it.each([new Response("private-response", { status: 401 }), Response.json({ unrelated: [] }), Response.json({ data: [{ missing: "id" }] }),
		new Response("x".repeat(1_048_577)), Response.json({ data: [], has_more: true })])("retains the old custom aggregate on incomplete or invalid discovery", async (upstream) => {
		const backend = setup(async () => upstream);
		await createCustom(backend); const before = await backend.api.getCustomLlmProvider("custom-local");
		const response = await request(backend, "providers/custom-local/models", "POST");
		expect(response.status).toBe(502); const text = await response.text(); expect(text).not.toContain("private-response");
		expect(JSON.parse(text)).toMatchObject({ error: { code: "llm_model_refresh_failed" } });
		expect(await backend.api.getCustomLlmProvider("custom-local")).toEqual(before);
	});

	it("treats a complete empty custom catalog as an explicit successful replacement", async () => {
		const backend = setup(); await createCustom(backend);
		expect((await request(backend, "providers/custom-local/models", "POST")).status).toBe(200);
		expect((await backend.api.getCustomLlmProvider("custom-local")).models).toEqual([]);
		expect(backend.llmModelCatalog.getModels("custom-local")).toEqual([]);
	});

	it("reads all Google discovery pages before replacement and normalizes names without granting remote capability metadata", async () => {
		const customFetch = vi.fn<typeof fetch>(async (input) => new URL(String(input)).searchParams.has("pageToken")
			? Response.json({ models: [{ name: "models/two", displayName: "Two", inputTokenLimit: 1_000_000 }] })
			: Response.json({ models: [{ name: "models/one", displayName: "One" }], nextPageToken: "next" }));
		const backend = setup(customFetch); await createCustom(backend, { api: "google-generative-ai" });
		expect((await request(backend, "providers/custom-local/models", "POST")).status).toBe(200);
		expect((await backend.api.getCustomLlmProvider("custom-local")).models.map((model) => [model.id, model.contextWindow])).toEqual([["one", 32_768], ["two", 32_768]]);
		expect(String(customFetch.mock.calls[1]![0])).toBe("https://llm.example.test/v1/models?pageToken=next");
	});

	it("follows Anthropic cursors before replacing the catalog", async () => {
		const customFetch = vi.fn<typeof fetch>(async (input) => new URL(String(input)).searchParams.has("after_id")
			? Response.json({ data: [{ id: "two", display_name: "Two" }], has_more: false })
			: Response.json({ data: [{ id: "one", display_name: "One" }], has_more: true, last_id: "one" }));
		const backend = setup(customFetch); await createCustom(backend, { api: "anthropic-messages" });
		expect((await request(backend, "providers/custom-local/models", "POST")).status).toBe(200);
		expect((await backend.api.getCustomLlmProvider("custom-local")).models.map((model) => model.name)).toEqual(["One", "Two"]);
		expect(String(customFetch.mock.calls[1]![0])).toBe("https://llm.example.test/v1/models?after_id=one");
	});

	it("does not overwrite provider changes made while discovery is pending", async () => {
		const pending = pendingResponse(); const backend = setup(pending.fetcher); await createCustom(backend);
		const refresh = request(backend, "providers/custom-local/models", "POST");
		await expect.poll(() => pending.fetcher.mock.calls.length).toBe(1);
		await backend.api.updateCustomLlmProvider({ ...providerInput(), providerId: "custom-local", expectedRevision: 1, name: "New configuration" });
		pending.finish(Response.json({ data: [{ id: "late-result" }] }));
		const response = await refresh; expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "revision_conflict" } });
		expect(await backend.api.getCustomLlmProvider("custom-local")).toMatchObject({ name: "New configuration", revision: 2 });
		expect(backend.llmModelCatalog.getModel("custom-local", "late-result")).toBeUndefined();
	});

	it("rejects a late refresh after deletion and recreation even with the same provider revision and configuration", async () => {
		const pending = pendingResponse(); const backend = setup(pending.fetcher); await createCustom(backend);
		const refresh = request(backend, "providers/custom-local/models", "POST"); await expect.poll(() => pending.fetcher.mock.calls.length).toBe(1);
		await backend.api.deleteCustomLlmProvider({ providerId: "custom-local", expectedRevision: 1 });
		await createCustom(backend); pending.finish(Response.json({ data: [{ id: "late-result" }] }));
		expect((await refresh).status).toBe(409); expect((await backend.api.getCustomLlmProvider("custom-local")).revision).toBe(1);
		expect(backend.llmModelCatalog.getModel("custom-local", "late-result")).toBeUndefined();
	});

	it("rejects discovery results after credentials rotate", async () => {
		const pending = pendingResponse(); const backend = setup(pending.fetcher);
		expect((await request(backend, "custom-providers", "POST", { ...providerInput(), authMode: "api_key", credential: { type: "api_key", apiKey: "old" } })).status).toBe(201);
		const refresh = request(backend, "providers/custom-local/models", "POST"); await expect.poll(() => pending.fetcher.mock.calls.length).toBe(1);
		await backend.api.configureLlmProviderApiKey({ providerId: "custom-local", apiKey: "new", expectedRevision: 1 });
		pending.finish(Response.json({ data: [{ id: "late-result" }] }));
		expect((await refresh).status).toBe(409); expect((await backend.api.getCustomLlmProvider("custom-local")).revision).toBe(1);
	});

	it("rejects late discovery after credentials are deleted and recreated with their revision reset", async () => {
		const pending = pendingResponse(); const backend = setup(pending.fetcher);
		expect((await request(backend, "custom-providers", "POST", { ...providerInput(), authMode: "api_key", credential: { type: "api_key", apiKey: "old" } })).status).toBe(201);
		const refresh = request(backend, "providers/custom-local/models", "POST"); await expect.poll(() => pending.fetcher.mock.calls.length).toBe(1);
		await backend.api.deleteLlmProviderCredential({ providerId: "custom-local", expectedRevision: 1 });
		await backend.api.configureLlmProviderApiKey({ providerId: "custom-local", apiKey: "new" });
		pending.finish(Response.json({ data: [] })); expect((await refresh).status).toBe(409);
		expect((await backend.api.getCustomLlmProvider("custom-local")).revision).toBe(1);
	});

	it("does not publish an aborted request even if its transport returns a late result", async () => {
		const pending = pendingResponse(); const backend = setup(pending.fetcher); await createCustom(backend);
		const controller = new AbortController();
		const refresh = backend.api.refreshLlmProviderModels("custom-local", controller.signal);
		await expect.poll(() => pending.fetcher.mock.calls.length).toBe(1); controller.abort();
		pending.finish(Response.json({ data: [] })); await expect(refresh).rejects.toThrow();
		expect((await backend.api.getCustomLlmProvider("custom-local")).revision).toBe(1);
	});

	it("serializes scheduled and manual refreshes for the same built-in provider", async () => {
		const pending = pendingResponse(); const backend = setup(undefined, pending.fetcher);
		const first = backend.llmModelCatalog.refresh("anthropic"); await expect.poll(() => pending.fetcher.mock.calls.length).toBe(1);
		const second = request(backend, "providers/anthropic/models", "POST");
		await Promise.resolve(); expect(pending.fetcher).toHaveBeenCalledTimes(1);
		pending.fetcher.mockImplementation(async () => Response.json({ models: [] }));
		pending.finish(Response.json({ models: [] }, { headers: { etag: "old-version" } }));
		await first; expect((await second).status).toBe(200); expect(pending.fetcher).toHaveBeenCalledTimes(2);
		expect(new Headers(pending.fetcher.mock.calls[1]![1]?.headers).get("if-none-match")).toBe("old-version");
	});

	it("keeps models removed by a concurrent Run out of an unchanged in-flight catalog response", async () => {
		const pending = pendingResponse(); const backend = setup(undefined, pending.fetcher);
		pending.fetcher.mockImplementationOnce(async () => Response.json({ models: [{ id: "model", name: "Model", api: "faux", baseUrl: "https://api.test",
			reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }, { headers: { etag: "version" } }));
		await backend.llmModelCatalog.refresh("anthropic");
		const refresh = backend.llmModelCatalog.refresh("anthropic"); await expect.poll(() => pending.fetcher.mock.calls.length).toBe(2);
		expect(backend.llmModelCatalog.removeModel("anthropic", "model")).toBe(true);
		pending.finish(new Response(null, { status: 304 })); await refresh;
		expect(backend.llmModelCatalog.getModels("anthropic")).toEqual([]);
	});

	it("blocks mutation when a chat run starts while discovery is pending", async () => {
		const pending = pendingResponse(); const backend = setup(pending.fetcher); await createCustom(backend);
		const refresh = request(backend, "providers/custom-local/models", "POST"); await expect.poll(() => pending.fetcher.mock.calls.length).toBe(1);
		backend.database.exec("PRAGMA foreign_keys = OFF");
		backend.database.prepare(`INSERT INTO chat_runs (id, session_id, workspace_id, request_id, provider_id, model_id, thinking_level,
			server_interaction_mode, status, created_at, updated_at) VALUES ('run', 'session', 'workspace', 'request', 'custom-local', 'keep', 'off', 'command', 'running', 1, 1)`).run();
		backend.database.exec("PRAGMA foreign_keys = ON");
		pending.finish(Response.json({ data: [] })); const response = await refresh;
		expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "llm_provider_in_use" } });
		expect((await backend.api.getCustomLlmProvider("custom-local")).revision).toBe(1);
	});
});
