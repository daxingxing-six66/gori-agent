import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("LLM Provider management HTTP API", () => {
	it("exposes Provider metadata and Model catalogs from pi-ai", async () => {
		const backend = createBackend();
		try {
			const providers = await request(backend.handleRequest, "GET", "/api/llm/providers");
			expect(providers.status).toBe(200);
			expect(providers.body).toEqual({
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						custom: false,
						baseUrl: "https://api.anthropic.test",
						auth: { apiKey: true, oauth: false },
						configured: false,
						credential: null,
						modelCount: 1,
					},
					{
						id: "openai",
						name: "OpenAI",
						custom: false,
						baseUrl: null,
						auth: { apiKey: true, oauth: false },
						configured: false,
						credential: null,
						modelCount: 1,
					},
				],
			});

			const models = await request(backend.handleRequest, "GET", "/api/llm/providers/anthropic/models");
			expect(models.status).toBe(200);
			expect(models.body).toEqual({
				providerId: "anthropic",
				models: [
					{
						id: "claude-sonnet-test",
						providerId: "anthropic",
						name: "Claude Sonnet Test",
						api: "faux",
						reasoning: true,
						supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
						input: ["text"],
						contextWindow: 128_000,
						maxTokens: 16_384,
					},
				],
			});
		} finally {
			backend.close();
		}
	});

	it("stores API keys encrypted and exposes only Credential metadata", async () => {
		const backend = createBackend();
		try {
			const created = await request(backend.handleRequest, "PUT", "/api/llm/providers/anthropic/credential", {
				type: "api_key",
				apiKey: "secret-anthropic-key",
			});
			expect(created.status).toBe(200);
			expect(created.body).toEqual({
				providerId: "anthropic",
				type: "api_key",
				revision: 1,
				createdAt: 1_000,
				updatedAt: 1_000,
			});
			expect(JSON.stringify(created.body)).not.toContain("secret-anthropic-key");

			const secret = backend.database
				.prepare("SELECT ciphertext FROM llm_provider_credential_secrets WHERE provider_id = ?")
				.get("anthropic");
			expect(secret?.ciphertext).toBeInstanceOf(Uint8Array);
			expect(Buffer.from(secret?.ciphertext as Uint8Array).toString("utf8")).not.toContain("secret-anthropic-key");

			const providers = await request(backend.handleRequest, "GET", "/api/llm/providers");
			expect(providers.body).toMatchObject({ providers: expect.any(Array) });
			const providerList = (providers.body as { providers: unknown[] }).providers;
			expect(providerList[0]).toMatchObject({ id: "anthropic", configured: true, credential: { revision: 1 } });
			const listed = await request(backend.handleRequest, "GET", "/api/llm/provider-credentials");
			expect(listed.body).toEqual({ credentials: [created.body] });
			expect((await backend.llmModels.getAuth("anthropic"))?.auth.apiKey).toBe("secret-anthropic-key");
		} finally {
			backend.close();
		}
	});

	it("uses revision checks when replacing and deleting a Provider Credential", async () => {
		const backend = createBackend();
		try {
			await request(backend.handleRequest, "PUT", "/api/llm/providers/anthropic/credential", {
				type: "api_key",
				apiKey: "first-key",
			});
			const updated = await request(backend.handleRequest, "PUT", "/api/llm/providers/anthropic/credential", {
				type: "api_key",
				apiKey: "second-key",
				expectedRevision: 1,
			});
			expect(updated.body).toMatchObject({ revision: 2 });

			const staleUpdate = await request(backend.handleRequest, "PUT", "/api/llm/providers/anthropic/credential", {
				type: "api_key",
				apiKey: "stale-key",
				expectedRevision: 1,
			});
			expect(staleUpdate.status).toBe(409);
			expect(staleUpdate.body).toMatchObject({ error: { code: "revision_conflict" } });
			expect((await backend.llmModels.getAuth("anthropic"))?.auth.apiKey).toBe("second-key");
			const invalidDelete = await request(
				backend.handleRequest,
				"DELETE",
				"/api/llm/providers/anthropic/credential?expectedRevision=0",
			);
			expect(invalidDelete.status).toBe(400);
			expect(invalidDelete.body).toMatchObject({
				error: { code: "validation_error", field: "expectedRevision" },
			});

			expect(
				(
					await request(
						backend.handleRequest,
						"DELETE",
						"/api/llm/providers/anthropic/credential?expectedRevision=1",
					)
				).status,
			).toBe(409);
			expect(
				(
					await request(
						backend.handleRequest,
						"DELETE",
						"/api/llm/providers/anthropic/credential?expectedRevision=2",
					)
				).status,
			).toBe(204);
			expect(
				backend.database
					.prepare("SELECT 1 FROM llm_provider_credential_secrets WHERE provider_id = ?")
					.get("anthropic"),
			).toBeUndefined();
			expect((await backend.llmModels.checkAuth("anthropic"))?.type).toBeUndefined();
		} finally {
			backend.close();
		}
	});

	it("rolls back Credential metadata when encrypted Secret replacement fails", async () => {
		const backend = createBackend();
		try {
			await request(backend.handleRequest, "PUT", "/api/llm/providers/anthropic/credential", {
				type: "api_key",
				apiKey: "original-key",
			});
			backend.database.exec(`
				CREATE TRIGGER reject_llm_secret_update
				BEFORE UPDATE ON llm_provider_credential_secrets
				BEGIN
					SELECT RAISE(ABORT, 'secret rejected');
				END;
			`);

			const rejected = await request(backend.handleRequest, "PUT", "/api/llm/providers/anthropic/credential", {
				type: "api_key",
				apiKey: "rejected-key",
				expectedRevision: 1,
			});
			expect(rejected.status).toBe(500);
			expect(rejected.body).toMatchObject({ error: { code: "secret_store_failed" } });
			expect(
				(await request(backend.handleRequest, "GET", "/api/llm/providers/anthropic/credential")).body,
			).toMatchObject({ revision: 1 });
			expect((await backend.llmModels.getAuth("anthropic"))?.auth.apiKey).toBe("original-key");
		} finally {
			backend.close();
		}
	});

	it("rejects unknown Providers and unsupported HTTP credential types", async () => {
		const backend = createBackend();
		try {
			expect((await request(backend.handleRequest, "GET", "/api/llm/providers/unknown/models")).status).toBe(404);
			expect(
				(
					await request(backend.handleRequest, "PUT", "/api/llm/providers/unknown/credential", {
						type: "api_key",
						apiKey: "secret",
					})
				).status,
			).toBe(404);
			const oauth = await request(backend.handleRequest, "PUT", "/api/llm/providers/anthropic/credential", {
				type: "oauth",
				apiKey: "not-an-oauth-token",
			});
			expect(oauth.status).toBe(400);
			expect(oauth.body).toMatchObject({ error: { code: "validation_error", field: "type" } });
		} finally {
			backend.close();
		}
	});

	it("preserves an encrypted Provider Credential and migration records across reopening", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-ssh-agent-llm-"));
		const databasePath = join(directory, "management.sqlite");
		let backend = createBackend(databasePath);
		try {
			await request(backend.handleRequest, "PUT", "/api/llm/providers/openai/credential", {
				type: "api_key",
				apiKey: "persisted-key",
			});
			const versionsBefore = backend.database
				.prepare("SELECT version, applied_at FROM ssh_agent_schema_migrations ORDER BY version")
				.all();
			await backend.close();
			backend = createBackend(databasePath);
			expect((await backend.llmModels.getAuth("openai"))?.auth.apiKey).toBe("persisted-key");
			expect(
				backend.database
					.prepare("SELECT version, applied_at FROM ssh_agent_schema_migrations ORDER BY version")
					.all(),
			).toEqual(versionsBefore);
			expect(backend.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			try {
				await backend.close();
			} catch {
				// The first backend may already be closed when reopening fails.
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function createBackend(databasePath = ":memory:") {
	return createSqliteManagementBackend({
		databasePath,
		credentialEncryptionKey: new Uint8Array(32).fill(9),
		clock: { now: () => 1_000 },
		llmModelsFactory: createTestLlmModels,
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
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}
