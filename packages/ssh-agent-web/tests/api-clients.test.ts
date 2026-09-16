import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialApi } from "../features/credential/api/credential-api.ts";
import { chatApi } from "../features/chat/api/chat-api.ts";
import { contextCompactionSettingsApi } from "../features/context-compaction/api/context-compaction-settings-api.ts";
import { guardApi } from "../features/guard/api/guard-api.ts";
import { llmProviderApi } from "../features/llm-provider/api/llm-provider-api.ts";
import { sessionApi } from "../features/session/api/session-api.ts";
import { sessionAttachmentApi } from "../features/session/api/session-attachment-api.ts";
import { workspaceApi } from "../features/workspace/api/workspace-api.ts";
import { apiRequest, apiUrlWithLocale, requestLocale } from "../shared/api/client.ts";

afterEach(() => vi.unstubAllGlobals());

function mockResponse(body: unknown, status = 200): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(() =>
		Promise.resolve(status === 204 ? new Response(null, { status }) : Response.json(body, { status })),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("management API clients", () => {
	it("sends the active locale on REST requests and encodes SSE locale queries", async () => {
		vi.stubGlobal("document", {
			documentElement: { dataset: { locale: "en-US" }, lang: "en-US" },
		});
		const fetchMock = mockResponse({});
		await apiRequest("/api/health");
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/health",
			expect.objectContaining({ headers: expect.objectContaining({ "accept-language": "en-US" }) }),
		);
		expect(requestLocale()).toBe("en-US");
		expect(apiUrlWithLocale("/api/workspaces/ws-1/events?topics=monitoring", "en-US"))
			.toBe("/api/workspaces/ws-1/events?topics=monitoring&locale=en-US");
	});

	it("uses the workspace tree endpoint without caching", async () => {
		const fetchMock = mockResponse({ workspaces: [] });
		await expect(workspaceApi.getTree()).resolves.toEqual({ workspaces: [] });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspace-session-tree",
			expect.objectContaining({ cache: "no-store", method: "GET" }),
		);
	});

	it("encodes revisions in delete queries and accepts empty responses", async () => {
		const fetchMock = mockResponse(undefined, 204);
		await expect(sessionApi.delete("session / 1", 7)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201?expectedRevision=7",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("sends Session local runtime settings and Chat queue behavior", async () => {
		let fetchMock = mockResponse({ id: "session-1", workDir: "/tmp/user", autoAudit: true }, 201);
		await sessionApi.create("workspace / 1", "Deploy", { workDir: "/tmp/user", autoAudit: true });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/workspace%20%2F%201/sessions",
			expect.objectContaining({ method: "POST" }),
		);
		let init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({ displayName: "Deploy", workDir: "/tmp/user", autoAudit: true });

		fetchMock = mockResponse({
			id: "session-1",
			workDir: "/tmp/user",
			autoAudit: true,
			chatModelSelection: { providerId: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "medium" },
		});
		await expect(sessionApi.get("session-1")).resolves.toMatchObject({
			chatModelSelection: { providerId: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "medium" },
		});

		fetchMock = mockResponse({ id: "session-1", workDir: "/tmp/user", autoAudit: true });
		await sessionApi.update("session-1", { workDir: "/tmp/user", autoAudit: true, expectedRevision: 2 });
		init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({ workDir: "/tmp/user", autoAudit: true, expectedRevision: 2 });

		fetchMock = mockResponse({ id: "queue-1", status: "pending" }, 201);
		await chatApi.enqueue("session / 1", "run / 1", { requestId: "request-1", behavior: "steer", message: "check logs" });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/runs/run%20%2F%201/queue",
			expect.objectContaining({ method: "POST" }),
		);
		init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toMatchObject({ behavior: "steer", message: "check logs" });

		fetchMock = mockResponse({ run: { id: "run / 1", status: "running" } });
		await expect(chatApi.getActiveRun("session / 1")).resolves.toMatchObject({ run: { id: "run / 1" } });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/runs/active",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse({ items: [{ id: "queue / 1", status: "pending" }] });
		await expect(chatApi.listQueue("session / 1", "run / 1")).resolves.toMatchObject({ items: [{ id: "queue / 1" }] });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/runs/run%20%2F%201/queue?status=pending",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse(undefined, 204);
		await expect(chatApi.cancelQueued("session / 1", "run / 1", "queue / 1")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/runs/run%20%2F%201/queue/queue%20%2F%201",
			expect.objectContaining({ method: "DELETE" }),
		);

		fetchMock = mockResponse({ status: "skipped", reason: "nothing_to_compact", attempts: 0 });
		await expect(chatApi.compact("session / 1")).resolves.toEqual({
			status: "skipped",
			reason: "nothing_to_compact",
			attempts: 0,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/compactions",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("uploads Session image attachments as raw bytes without JSON encoding", async () => {
		const attachment = {
			id: "attachment-1",
			sessionId: "session / 1",
			name: "architecture diagram.png",
			mimeType: "image/png",
			size: 3,
			storagePath: "attachments/sessions/session-1/architecture diagram.png",
			contentUrl: "/api/sessions/session-1/attachments/attachment-1/content",
			createdAt: 1,
		};
		const image = new File(["png"], attachment.name, { type: attachment.mimeType });
		const fetchMock = mockResponse(attachment, 201);

		await expect(sessionAttachmentApi.upload("session / 1", image)).resolves.toEqual(attachment);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/attachments?name=architecture%20diagram.png",
			expect.objectContaining({
				method: "POST",
				body: image,
				headers: expect.objectContaining({
					"content-type": "image/png",
					"accept-language": "zh-CN",
				}),
			}),
		);
	});

	it("sends uploaded image IDs with Chat Runs and queued messages", async () => {
		let fetchMock = mockResponse({ id: "run-1", status: "pending" }, 201);
		await chatApi.createRun("session / 1", {
			requestId: "request-1",
			providerId: "vision-provider",
			modelId: "vision-model",
			thinkingLevel: "off",
			message: "compare these screenshots",
			attachmentIds: ["attachment-2", "attachment-1"],
			serverInteractionMode: "command",
		});
		let init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toMatchObject({
			message: "compare these screenshots",
			attachmentIds: ["attachment-2", "attachment-1"],
		});

		fetchMock = mockResponse({ id: "queue-1", status: "pending" }, 201);
		await chatApi.enqueue("session / 1", "run / 1", {
			requestId: "queue-1",
			behavior: "follow_up",
			message: "",
			attachmentIds: ["attachment-3"],
		});
		init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toMatchObject({
			behavior: "follow_up",
			message: "",
			attachmentIds: ["attachment-3"],
		});
	});

	it("reads the latest Chat page and encodes directional message cursors", async () => {
		const page = { messages: [], nextBeforeSequence: null, nextSequence: null };
		let fetchMock = mockResponse(page);
		await expect(chatApi.listMessages("session / 1", { limit: 25 })).resolves.toEqual(page);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/messages?limit=25",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse({ ...page, nextBeforeSequence: 101 });
		await chatApi.listMessages("session / 1", { beforeSequence: 201, limit: 100 });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/messages?limit=100&beforeSequence=201",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse({ ...page, nextSequence: 300 });
		await chatApi.listMessages("session / 1", { afterSequence: 200, limit: 100 });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sessions/session%20%2F%201/chat/messages?limit=100&afterSequence=200",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("sends credential secrets only in the create request body", async () => {
		const credential = {
			id: "cred-1",
			workspaceId: "ws-1",
			displayName: "deploy",
			remoteUser: "root",
			type: "password",
			authVersion: 1,
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const fetchMock = mockResponse(credential, 201);
		await expect(
			credentialApi.create("ws-1", {
				displayName: "deploy",
				remoteUser: "root",
				type: "password",
				password: "secret",
			}),
		).resolves.toEqual(credential);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws-1/credentials",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({
			displayName: "deploy",
			remoteUser: "root",
			type: "password",
			password: "secret",
		});
		expect(credential).not.toHaveProperty("password");
	});

	it("creates a workspace and its first credential atomically", async () => {
		const response = {
			workspace: { id: "ws-1", activeCredentialId: "cred-1" },
			activeCredential: { id: "cred-1", workspaceId: "ws-1" },
		};
		const fetchMock = mockResponse(response, 201);
		const credential = {
			displayName: "root",
			remoteUser: "root",
			type: "password" as const,
			password: "secret",
		};
		await expect(
			workspaceApi.create({
				displayName: "Production",
				environment: "production",
				host: {
					hostname: "10.0.0.1",
					port: 22,
				},
				credential,
				defaultCwd: "/srv/app",
			}),
		).resolves.toEqual(response);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
		expect(requestBody).toMatchObject({ credential });
		expect(requestBody.host).toEqual({ hostname: "10.0.0.1", port: 22 });
		expect(requestBody.host).not.toHaveProperty("hostKey");
	});

	it("uses workspace-scoped credential read endpoints", async () => {
		const list = { workspaceId: "ws / 1", activeCredentialId: "cred-1", workspaceRevision: 3, credentials: [] };
		let fetchMock = mockResponse(list);
		await expect(credentialApi.list("ws / 1")).resolves.toEqual(list);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws%20%2F%201/credentials",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse({ id: "cred / 1", workspaceId: "ws / 1" });
		await credentialApi.get("ws / 1", "cred / 1");
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws%20%2F%201/credentials/cred%20%2F%201",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse({ workspaceId: "ws / 1", workspaceRevision: 3, credential: { id: "cred-1" } });
		await credentialApi.getActive("ws / 1");
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws%20%2F%201/active-credential",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("switches the active credential with the workspace revision", async () => {
		const response = { workspace: { id: "ws-1", revision: 4 }, activeCredential: { id: "cred-2" } };
		const fetchMock = mockResponse(response);
		await expect(credentialApi.activate("ws-1", "cred-2", 3)).resolves.toEqual(response);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws-1/active-credential",
			expect.objectContaining({ method: "PUT" }),
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({ credentialId: "cred-2", expectedRevision: 3 });
	});

	it("deletes a non-active credential with its own revision", async () => {
		const fetchMock = mockResponse(undefined, 204);
		await expect(credentialApi.delete("ws / 1", "cred / 2", 7)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws%20%2F%201/credentials/cred%20%2F%202?expectedRevision=7",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("sends complete Guard replacements with expectedRevision", async () => {
		const guard = {
			id: "guard-1",
			workspaceId: "ws-1",
			enabled: true,
			rules: [],
			revision: 2,
			createdAt: 1,
			updatedAt: 2,
		};
		const fetchMock = mockResponse(guard);
		const newRule = {
			id: "rule-1",
			displayName: "禁止关机",
			pattern: "shutdown",
			match: "starts_with" as const,
			enabled: true,
			source: "builtin" as const,
			originRuleId: "linux.power.shutdown",
			packId: "linux-critical",
			packVersion: "1.0.0",
			level: "critical" as const,
		};
		await guardApi.update("ws-1", true, [newRule], 1);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({
			enabled: true,
			rules: [{
				id: "rule-1",
				displayName: "禁止关机",
				pattern: "shutdown",
				match: "starts_with",
				enabled: true,
			}],
			expectedRevision: 1,
		});
	});

	it("lists and imports Guard rule packs through workspace-scoped endpoints", async () => {
		const catalog = { workspaceId: "ws / 1", guardRevision: 3, packs: [] };
		let fetchMock = mockResponse(catalog);
		await expect(guardApi.listRulePacks("ws / 1")).resolves.toEqual(catalog);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws%20%2F%201/guard/rule-packs",
			expect.objectContaining({ method: "GET" }),
		);

		const imported = { guard: { id: "guard-1", revision: 4, rules: [] }, results: [] };
		fetchMock = mockResponse(imported);
		await expect(guardApi.importRulePacks("ws / 1", ["linux-critical", "ssh-protection"], 3)).resolves.toEqual(imported);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws%20%2F%201/guard/rule-packs/import",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({
			packIds: ["linux-critical", "ssh-protection"],
			expectedRevision: 3,
		});
	});

	it("reads the LLM Provider catalog, models, and Credential metadata", async () => {
		const providerList = {
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					baseUrl: "https://api.openai.com/v1",
					auth: { apiKey: true, oauth: false },
					configured: true,
					credential: { providerId: "openai", type: "api_key", revision: 1 },
					modelCount: 2,
				},
			],
		};
		let fetchMock = mockResponse(providerList);
		await expect(llmProviderApi.listProviders()).resolves.toEqual(providerList);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/llm/providers",
			expect.objectContaining({ method: "GET", cache: "no-store" }),
		);

		const models = {
			providerId: "provider / 1",
			models: [{
				id: "model-1",
				providerId: "provider / 1",
				name: "Model 1",
				api: "test",
				reasoning: true,
				supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 8_192,
			}],
		};
		fetchMock = mockResponse(models);
		await expect(llmProviderApi.listModels("provider / 1")).resolves.toEqual(models);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/llm/providers/provider%20%2F%201/models",
			expect.objectContaining({ method: "GET" }),
		);

		const credentials = { credentials: [{ providerId: "openai", type: "api_key", revision: 1 }] };
		fetchMock = mockResponse(credentials);
		await expect(llmProviderApi.listCredentials()).resolves.toEqual(credentials);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/llm/provider-credentials",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse(credentials.credentials[0]);
		await expect(llmProviderApi.getCredential("provider / 1")).resolves.toEqual(credentials.credentials[0]);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/llm/providers/provider%20%2F%201/credential",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("reads and replaces global context compaction settings with a revision", async () => {
		const settings = {
			triggerPercent: 80,
			model: null,
			revision: 2,
			updatedAt: 1_787_000_000_000,
		};
		let fetchMock = mockResponse(settings);
		await expect(contextCompactionSettingsApi.get()).resolves.toEqual(settings);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/settings/compaction",
			expect.objectContaining({ method: "GET", cache: "no-store" }),
		);

		const updated = {
			...settings,
			triggerPercent: 72,
			model: { providerId: "deepseek", modelId: "deepseek-chat" },
			revision: 3,
		};
		fetchMock = mockResponse(updated);
		await expect(contextCompactionSettingsApi.update({
			triggerPercent: 72,
			model: { providerId: "deepseek", modelId: "deepseek-chat" },
		}, 2)).resolves.toEqual(updated);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/settings/compaction?expectedRevision=2",
			expect.objectContaining({ method: "PUT" }),
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({
			triggerPercent: 72,
			model: { providerId: "deepseek", modelId: "deepseek-chat" },
		});
	});

	it("creates and replaces Provider Credentials with the shared apiKey field", async () => {
		let fetchMock = mockResponse({ providerId: "openai", type: "api_key", revision: 1 });
		await llmProviderApi.configureCredential("openai", "first-secret");
		let init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({ type: "api_key", apiKey: "first-secret" });
		expect(JSON.parse(String(init.body))).not.toHaveProperty("expectedRevision");
		expect(JSON.parse(String(init.body))).not.toHaveProperty("baseUrl");

		fetchMock = mockResponse({ providerId: "openai", type: "api_key", revision: 2 });
		await llmProviderApi.configureCredential("openai", "replacement-secret", 1);
		init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({
			type: "api_key",
			apiKey: "replacement-secret",
			expectedRevision: 1,
		});
	});

	it("deletes Provider Credentials with an encoded Provider ID and revision", async () => {
		const fetchMock = mockResponse(undefined, 204);
		await expect(llmProviderApi.deleteCredential("provider / 1", 7)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/llm/providers/provider%20%2F%201/credential?expectedRevision=7",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("manages custom Providers with complete model replacements and revisions", async () => {
		const provider = {
			id: "custom-local",
			name: "Local LLM",
			baseUrl: "http://127.0.0.1:11434/v1",
			api: "openai-completions",
			authMode: "none",
			compat: {},
			models: [{
				id: "local-model",
				name: "Local Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_768,
				maxTokens: 8_192,
			}],
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		let fetchMock = mockResponse({ providers: [provider] });
		await expect(llmProviderApi.listCustomProviders()).resolves.toEqual({ providers: [provider] });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/llm/custom-providers",
			expect.objectContaining({ method: "GET" }),
		);

		fetchMock = mockResponse(provider, 201);
		const createdProvider = await llmProviderApi.createCustomProvider({
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: "openai-completions",
			authMode: "api_key",
			compat: {},
			models: provider.models.map((model) => ({ ...model, input: ["text"] })),
			credential: { type: "api_key", apiKey: "atomic-secret" },
		});
		let init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toMatchObject({
			id: "custom-local",
			authMode: "api_key",
			credential: { type: "api_key", apiKey: "atomic-secret" },
			models: [{ id: "local-model", contextWindow: 32_768, maxTokens: 8_192 }],
		});
		expect(createdProvider).not.toHaveProperty("credential");

		fetchMock = mockResponse({ ...provider, revision: 2 });
		await llmProviderApi.updateCustomProvider(provider.id, {
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: "openai-responses",
			authMode: "api_key",
			compat: { supportsStrictMode: true },
			models: [],
			expectedRevision: 1,
		});
		init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({
			name: "Local LLM",
			baseUrl: "http://127.0.0.1:11434/v1",
			api: "openai-responses",
			authMode: "api_key",
			compat: { supportsStrictMode: true },
			models: [],
			expectedRevision: 1,
		});

		fetchMock = mockResponse(undefined, 204);
		await expect(llmProviderApi.deleteCustomProvider("custom / local", 2)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/llm/custom-providers/custom%20%2F%20local?expectedRevision=2",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("turns structured non-2xx responses into ApiError", async () => {
		mockResponse({ error: { code: "revision_conflict", message: "changed", field: "displayName" } }, 409);
		const request = workspaceApi.rename("ws-1", "new name", 1);
		await expect(request).rejects.toMatchObject({
			status: 409,
			code: "revision_conflict",
			field: "displayName",
		});
	});
});
