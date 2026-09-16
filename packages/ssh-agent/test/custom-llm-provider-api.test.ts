import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("custom LLM Provider management HTTP API", () => {
	it("atomically creates an API-key Provider with an encrypted Credential", async () => {
		const backend = createBackend();
		try {
			const created = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				authMode: "api_key",
				credential: { type: "api_key", apiKey: "create-time-secret" },
			});
			expect(created.status).toBe(201);
			expect(JSON.stringify(created.body)).not.toContain("create-time-secret");
			expect((await backend.llmModels.getAuth("custom-local"))?.auth.apiKey).toBe("create-time-secret");
			const metadata = backend.database
				.prepare("SELECT credential_type, revision FROM llm_provider_credentials WHERE provider_id = ?")
				.get("custom-local");
			expect(metadata).toEqual({ credential_type: "api_key", revision: 1 });
			const secret = backend.database
				.prepare("SELECT ciphertext FROM llm_provider_credential_secrets WHERE provider_id = ?")
				.get("custom-local") as { ciphertext: Uint8Array };
			expect(Buffer.from(secret.ciphertext).toString("utf8")).not.toContain("create-time-secret");
			const providers = await request(backend.handleRequest, "GET", "/api/llm/providers");
			expect(providers.body).toMatchObject({
				providers: expect.arrayContaining([
					expect.objectContaining({
						id: "custom-local",
						configured: true,
						credential: expect.objectContaining({ revision: 1 }),
					}),
				]),
			});
		} finally {
			await backend.close();
		}
	});

	it("rolls back Provider creation when Credential encryption persistence fails", async () => {
		const backend = createBackend();
		try {
			backend.database.exec(`
				CREATE TRIGGER reject_custom_llm_secret
				BEFORE INSERT ON llm_provider_credential_secrets
				BEGIN
					SELECT RAISE(ABORT, 'secret rejected');
				END;
			`);
			const rejected = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				authMode: "api_key",
				credential: { type: "api_key", apiKey: "rejected-secret" },
			});
			expect(rejected.status).toBe(500);
			expect(rejected.body).toMatchObject({ error: { code: "secret_store_failed" } });
			expect(
				backend.database.prepare("SELECT 1 FROM llm_custom_providers WHERE id = ?").get("custom-local"),
			).toBeUndefined();
			expect(
				backend.database
					.prepare("SELECT 1 FROM llm_provider_credentials WHERE provider_id = ?")
					.get("custom-local"),
			).toBeUndefined();
			expect(backend.llmModels.getProvider("custom-local")).toBeUndefined();
		} finally {
			await backend.close();
		}
	});

	it("reports nested Credential validation fields", async () => {
		const backend = createBackend();
		try {
			const rejected = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				authMode: "api_key",
				credential: { type: "api_key", apiKey: "   " },
			});
			expect(rejected.status).toBe(400);
			expect(rejected.body).toMatchObject({
				error: { code: "validation_error", field: "credential.apiKey" },
			});
		} finally {
			await backend.close();
		}
	});

	it("deletes a custom Provider and its Credential in one transaction", async () => {
		const backend = createBackend();
		try {
			await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				authMode: "api_key",
				credential: { type: "api_key", apiKey: "delete-with-provider" },
			});
			const deleted = await request(
				backend.handleRequest,
				"DELETE",
				"/api/llm/custom-providers/custom-local?expectedRevision=1",
			);
			expect(deleted.status).toBe(204);
			expect(
				backend.database
					.prepare("SELECT 1 FROM llm_provider_credentials WHERE provider_id = ?")
					.get("custom-local"),
			).toBeUndefined();
			expect(
				backend.database
					.prepare("SELECT 1 FROM llm_provider_credential_secrets WHERE provider_id = ?")
					.get("custom-local"),
			).toBeUndefined();
		} finally {
			await backend.close();
		}
	});

	it("rolls back Provider deletion when Credential deletion fails", async () => {
		const backend = createBackend();
		try {
			await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				authMode: "api_key",
				credential: { type: "api_key", apiKey: "keep-on-rollback" },
			});
			backend.database.exec(`
				CREATE TRIGGER reject_custom_llm_secret_delete
				BEFORE DELETE ON llm_provider_credential_secrets
				BEGIN
					SELECT RAISE(ABORT, 'secret delete rejected');
				END;
			`);
			const rejected = await request(
				backend.handleRequest,
				"DELETE",
				"/api/llm/custom-providers/custom-local?expectedRevision=1",
			);
			expect(rejected.status).toBe(500);
			expect(rejected.body).toMatchObject({ error: { code: "secret_store_failed" } });
			expect(
				backend.database.prepare("SELECT 1 FROM llm_custom_providers WHERE id = ?").get("custom-local"),
			).toBeDefined();
			expect(backend.llmModels.getProvider("custom-local")).toBeDefined();
		} finally {
			await backend.close();
		}
	});

	it("creates a keyless Provider, applies defaults, and exposes it through the shared catalog", async () => {
		const backend = createBackend();
		try {
			const created = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", providerInput());
			expect(created.status).toBe(201);
			expect(created.body).toMatchObject({
				id: "custom-local",
				authMode: "none",
				revision: 1,
				models: [
					{
						id: "local-model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			});

			const providers = await request(backend.handleRequest, "GET", "/api/llm/providers");
			expect(providers.body).toMatchObject({
				providers: expect.arrayContaining([
					expect.objectContaining({
						id: "custom-local",
						custom: true,
						auth: { apiKey: false, oauth: false },
						configured: true,
						modelCount: 1,
					}),
				]),
			});
			const models = await request(backend.handleRequest, "GET", "/api/llm/providers/custom-local/models");
			expect(models.body).toMatchObject({
				providerId: "custom-local",
				models: [{ id: "local-model", api: "openai-completions", contextWindow: 16_000, maxTokens: 4_000 }],
			});
			expect((await backend.llmModels.checkAuth("custom-local"))?.source).toBe("no authentication");
			const invalidCredential = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				id: "custom-keyless-with-key",
				credential: { type: "api_key", apiKey: "not-allowed" },
			});
			expect(invalidCredential.status).toBe(400);
			expect(invalidCredential.body).toMatchObject({
				error: { code: "validation_error", field: "credential" },
			});
			expect(
				(
					await request(backend.handleRequest, "PUT", "/api/llm/providers/custom-local/credential", {
						type: "api_key",
						apiKey: "not-needed",
					})
				).status,
			).toBe(400);
		} finally {
			await backend.close();
		}
	});

	it("exact-replaces models, enforces revisions, transitions auth, and deletes related data", async () => {
		const backend = createBackend();
		try {
			await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				authMode: "api_key",
			});
			await request(backend.handleRequest, "PUT", "/api/llm/providers/custom-local/credential", {
				type: "api_key",
				apiKey: "secret-key",
			});
			const updated = await request(backend.handleRequest, "PUT", "/api/llm/custom-providers/custom-local", {
				...providerInput(),
				id: undefined,
				name: "Updated Local",
				models: [],
				expectedRevision: 1,
			});
			expect(updated.status).toBe(200);
			expect(updated.body).toMatchObject({ name: "Updated Local", authMode: "none", models: [], revision: 2 });
			expect(await backend.llmModels.getAuth("custom-local")).toMatchObject({ source: "no authentication" });
			expect(
				backend.database
					.prepare("SELECT 1 FROM llm_provider_credentials WHERE provider_id = ?")
					.get("custom-local"),
			).toBeUndefined();

			const stale = await request(backend.handleRequest, "PUT", "/api/llm/custom-providers/custom-local", {
				...providerInput(),
				id: undefined,
				expectedRevision: 1,
			});
			expect(stale.status).toBe(409);
			expect(stale.body).toMatchObject({ error: { code: "revision_conflict" } });

			expect(
				(
					await request(
						backend.handleRequest,
						"DELETE",
						"/api/llm/custom-providers/custom-local?expectedRevision=2",
					)
				).status,
			).toBe(204);
			expect(backend.llmModels.getProvider("custom-local")).toBeUndefined();
		} finally {
			await backend.close();
		}
	});

	it("restores persisted Providers and never sends them to remote catalog refresh", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-ssh-agent-custom-llm-"));
		const databasePath = join(directory, "management.sqlite");
		const requests: string[] = [];
		let backend = createBackend(databasePath, (input) => {
			requests.push(String(input));
			return Promise.resolve(Response.json({ models: [] }));
		});
		try {
			await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				authMode: "api_key",
			});
			await request(backend.handleRequest, "PUT", "/api/llm/providers/custom-local/credential", {
				type: "api_key",
				apiKey: "persisted-key",
			});
			await backend.refreshLlmModels();
			expect(requests).toEqual([]);
			await backend.close();
			backend = createBackend(databasePath);
			expect(backend.llmModels.getModel("custom-local", "local-model")).toBeDefined();
			expect((await backend.llmModels.getAuth("custom-local"))?.auth.apiKey).toBe("persisted-key");
		} finally {
			try {
				await backend.close();
			} catch {
				// The previous backend may already be closed when reopening fails.
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects corrupted persisted Provider aggregates at the SQLite boundary", async () => {
		const backend = createBackend();
		try {
			await request(backend.handleRequest, "POST", "/api/llm/custom-providers", providerInput());
			backend.database
				.prepare("UPDATE llm_custom_providers SET models_json = ? WHERE id = ?")
				.run(JSON.stringify([{ id: "missing-required-fields" }]), "custom-local");
			await expect(backend.api.getCustomLlmProvider("custom-local")).rejects.toThrow(
				'Invalid stored custom LLM Provider "custom-local"',
			);
		} finally {
			await backend.close();
		}
	});

	it("rejects built-in IDs, invalid protocol compat, and mutations during an active run", async () => {
		const backend = createBackend();
		try {
			const invalidId = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				id: "anthropic",
			});
			expect(invalidId.status).toBe(409);
			expect(invalidId.body).toMatchObject({ error: { code: "llm_provider_conflict" } });
			await request(backend.handleRequest, "POST", "/api/llm/custom-providers", providerInput());
			const conflict = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", providerInput());
			expect(conflict.status).toBe(409);
			expect(conflict.body).toMatchObject({ error: { code: "llm_provider_conflict" } });

			const invalid = await request(backend.handleRequest, "POST", "/api/llm/custom-providers", {
				...providerInput(),
				id: "custom-invalid",
				api: "google-generative-ai",
				compat: { supportsDeveloperRole: true },
			});
			expect(invalid.status).toBe(400);
			expect(invalid.body).toMatchObject({
				error: { code: "validation_error", field: "compat.supportsDeveloperRole" },
			});

			backend.database.exec("PRAGMA foreign_keys = OFF");
			backend.database
				.prepare(`
					INSERT INTO chat_runs (
						id, session_id, workspace_id, request_id, provider_id, model_id, thinking_level,
						server_interaction_mode, status, created_at, updated_at
					) VALUES ('run', 'session', 'workspace', 'request', 'custom-local', 'local-model', 'off', 'command', 'running', 1, 1)
				`)
				.run();
			backend.database.exec("PRAGMA foreign_keys = ON");
			const inUse = await request(
				backend.handleRequest,
				"DELETE",
				"/api/llm/custom-providers/custom-local?expectedRevision=1",
			);
			expect(inUse.status).toBe(409);
			expect(inUse.body).toMatchObject({ error: { code: "llm_provider_in_use" } });
		} finally {
			await backend.close();
		}
	});
});

function providerInput() {
	return {
		id: "custom-local",
		name: "Local Provider",
		baseUrl: "http://127.0.0.1:11434/v1",
		api: "openai-completions",
		authMode: "none",
		compat: { supportsDeveloperRole: false },
		models: [{ id: "local-model", name: "Local Model", contextWindow: 16_000, maxTokens: 4_000 }],
	};
}

function createBackend(databasePath = ":memory:", catalogFetch?: typeof fetch) {
	return createSqliteManagementBackend({
		databasePath,
		credentialEncryptionKey: new Uint8Array(32).fill(7),
		clock: { now: () => 10_000 },
		llmModelsFactory: createTestLlmModels,
		...(catalogFetch === undefined ? {} : { llmCatalogFetch: catalogFetch }),
	});
}

async function request(
	handleRequest: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: unknown }> {
	const response = await handleRequest(
		new Request(`http://localhost${path}`, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		}),
	);
	return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}
