import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { IdGenerator } from "../src/domain/ids.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

class SequentialIds implements IdGenerator {
	private nextValue = 1;

	next(): string {
		const id = `id-${this.nextValue}`;
		this.nextValue += 1;
		return id;
	}
}

describe("SQLite management HTTP API", () => {
	it("atomically creates a Workspace, its active Credential, default Guard, and Sessions", async () => {
		const backend = createBackend();
		try {
			const workspaceResponse = await createWorkspace(backend.handleRequest, {
				displayName: "prod-web-01",
				credentialDisplayName: "Production root",
				password: "not-returned",
			});
			expect(workspaceResponse.status).toBe(201);
			expect(workspaceResponse.body).toMatchObject({
				workspace: {
					id: "id-1",
					displayName: "prod-web-01",
					host: { hostname: "localhost", port: 22, hostKey: null },
					activeCredentialId: "id-2",
					revision: 1,
				},
				activeCredential: {
					id: "id-2",
					workspaceId: "id-1",
					displayName: "Production root",
					type: "password",
					remoteUser: "root",
					authVersion: 1,
					revision: 1,
				},
			});
			expect(JSON.stringify(workspaceResponse.body)).not.toContain("not-returned");
			expect(
				backend.database.prepare("SELECT 1 FROM workspace_host_trusts WHERE workspace_id = ?").get("id-1"),
			).toBeUndefined();

			const secretRow = backend.database
				.prepare("SELECT ciphertext FROM credential_secrets WHERE credential_id = ?")
				.get("id-2");
			expect(secretRow?.ciphertext).toBeInstanceOf(Uint8Array);
			expect(Buffer.from(secretRow?.ciphertext as Uint8Array).toString("utf8")).not.toContain("not-returned");

			const guardResponse = await request(backend.handleRequest, "GET", "/api/workspaces/id-1/guard");
			expect(guardResponse.body).toEqual({
				id: "id-3",
				workspaceId: "id-1",
				enabled: false,
				rules: [],
				revision: 1,
				createdAt: 1_000,
				updatedAt: 1_000,
			});

			const sessionResponse = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", {
				displayName: "Deploy incident 42",
			});
			expect(sessionResponse.body).toMatchObject({
				id: "id-4",
				workspaceId: "id-1",
				workDir: null,
				autoAudit: false,
			});
			const updatedSession = await request(backend.handleRequest, "PATCH", "/api/sessions/id-4", {
				workDir: tmpdir(),
				autoAudit: true,
				expectedRevision: 1,
			});
			expect(updatedSession.body).toMatchObject({ workDir: await realpath(tmpdir()), autoAudit: true, revision: 2 });

			const treeResponse = await request(backend.handleRequest, "GET", "/api/workspace-session-tree");
			expect(treeResponse.body).toMatchObject({
				workspaces: [
					{
						workspace: { id: "id-1", activeCredentialId: "id-2" },
						sessions: [{ id: "id-4" }],
					},
				],
			});
			expect(JSON.stringify(treeResponse.body)).not.toContain("credentialId");

			const messages = await request(backend.handleRequest, "GET", "/api/sessions/id-4/chat/messages");
			expect(messages.body).toEqual({ messages: [], nextBeforeSequence: null, nextSequence: null });
			const sessionDetails = await request(backend.handleRequest, "GET", "/api/sessions/id-4");
			expect(sessionDetails.body).toMatchObject({ id: "id-4", chatModelSelection: null });
			const unconfiguredRun = await request(backend.handleRequest, "POST", "/api/sessions/id-4/chat/runs", {
				requestId: "run-1",
				providerId: "anthropic",
				modelId: "claude-sonnet-test",
				message: "hello",
				serverInteractionMode: "command",
			});
			expect(unconfiguredRun).toMatchObject({
				status: 409,
				body: { error: { code: "chat_provider_not_configured" } },
			});

			const activeCredential = await request(backend.handleRequest, "GET", "/api/workspaces/id-1/active-credential");
			expect(activeCredential.body).toMatchObject({
				workspaceId: "id-1",
				workspaceRevision: 1,
				credential: { id: "id-2", workspaceId: "id-1" },
			});
		} finally {
			backend.close();
		}
	});

	it("rolls back Workspace creation when Credential secret storage fails", async () => {
		const backend = createBackend();
		try {
			backend.database.exec(`
				CREATE TRIGGER reject_credential_secret
				BEFORE INSERT ON credential_secrets
				BEGIN
					SELECT RAISE(ABORT, 'secret rejected');
				END;
			`);
			const response = await createWorkspace(backend.handleRequest);
			expect(response.status).toBe(500);
			expect(response.body).toMatchObject({ error: { code: "secret_store_failed" } });
			for (const table of [
				"workspaces",
				"workspace_host_trusts",
				"credentials",
				"credential_secrets",
				"guards",
			] as const) {
				const row = backend.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
				expect(row?.count).toBe(0);
			}
		} finally {
			backend.close();
		}
	});

	it("serializes concurrent Workspace creation transactions", async () => {
		const backend = createBackend();
		try {
			const responses = await Promise.all([
				createWorkspace(backend.handleRequest, { displayName: "one" }),
				createWorkspace(backend.handleRequest, { displayName: "two" }),
			]);
			expect(responses.map((response) => response.status)).toEqual([201, 201]);
			const row = backend.database.prepare("SELECT COUNT(*) AS count FROM workspaces").get();
			expect(row?.count).toBe(2);
		} finally {
			backend.close();
		}
	});

	it("scopes multiple Credentials to one Workspace and switches the active Credential explicitly", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			const added = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/credentials", {
				displayName: "Backup login",
				remoteUser: "deploy",
				type: "private_key",
				privateKey: "backup-private-key",
			});
			expect(added.status).toBe(201);
			expect(added.body).toMatchObject({ id: "id-4", workspaceId: "id-1", type: "private_key" });
			expect(JSON.stringify(added.body)).not.toContain("backup-private-key");

			const credentials = await request(backend.handleRequest, "GET", "/api/workspaces/id-1/credentials");
			expect(credentials.body).toMatchObject({
				workspaceId: "id-1",
				activeCredentialId: "id-2",
				workspaceRevision: 1,
				credentials: [{ id: "id-4" }, { id: "id-2" }],
			});

			const activated = await request(backend.handleRequest, "PUT", "/api/workspaces/id-1/active-credential", {
				credentialId: "id-4",
				expectedRevision: 1,
			});
			expect(activated.body).toMatchObject({
				workspace: { activeCredentialId: "id-4", revision: 2 },
				activeCredential: { id: "id-4", workspaceId: "id-1" },
			});

			const idempotent = await request(backend.handleRequest, "PUT", "/api/workspaces/id-1/active-credential", {
				credentialId: "id-4",
				expectedRevision: 2,
			});
			expect(idempotent.body).toMatchObject({ workspace: { activeCredentialId: "id-4", revision: 2 } });

			const stale = await request(backend.handleRequest, "PUT", "/api/workspaces/id-1/active-credential", {
				credentialId: "id-2",
				expectedRevision: 1,
			});
			expect(stale.status).toBe(409);
			expect(stale.body).toMatchObject({ error: { code: "revision_conflict" } });

			expect(() =>
				backend.database.prepare("UPDATE credentials SET is_active = 1 WHERE id = ?").run("id-2"),
			).toThrow();
		} finally {
			backend.close();
		}
	});

	it("does not expose Credentials across Workspace boundaries", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest, { displayName: "one" });
			await createWorkspace(backend.handleRequest, { displayName: "two" });

			expect((await request(backend.handleRequest, "GET", "/api/workspaces/id-4/credentials/id-2")).status).toBe(
				404,
			);
			expect(
				(await request(backend.handleRequest, "DELETE", "/api/workspaces/id-4/credentials/id-2?expectedRevision=1"))
					.status,
			).toBe(404);
			expect(
				(
					await request(backend.handleRequest, "PUT", "/api/workspaces/id-4/active-credential", {
						credentialId: "id-2",
						expectedRevision: 1,
					})
				).status,
			).toBe(404);
		} finally {
			backend.close();
		}
	});

	it("rejects deleting the active Credential and cascades owned Credentials with Workspace deletion", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			backend.database
				.prepare(`INSERT INTO workspace_host_trusts (workspace_id, algorithm, fingerprint, verified_at)
					VALUES (?, ?, ?, ?)`)
				.run("id-1", "ssh-ed25519", "SHA256:owned", 900);
			await request(backend.handleRequest, "POST", "/api/workspaces/id-1/credentials", {
				displayName: "backup",
				remoteUser: "root",
				type: "password",
				password: "backup-password",
			});

			const activeDelete = await request(
				backend.handleRequest,
				"DELETE",
				"/api/workspaces/id-1/credentials/id-2?expectedRevision=1",
			);
			expect(activeDelete.status).toBe(409);
			expect(activeDelete.body).toMatchObject({ error: { code: "active_credential_in_use" } });

			const inactiveDelete = await request(
				backend.handleRequest,
				"DELETE",
				"/api/workspaces/id-1/credentials/id-4?expectedRevision=1",
			);
			expect(inactiveDelete.status).toBe(204);
			expect(
				backend.database.prepare("SELECT 1 FROM credential_secrets WHERE credential_id = ?").get("id-4"),
			).toBeUndefined();

			expect(
				(await request(backend.handleRequest, "DELETE", "/api/workspaces/id-1?expectedRevision=1")).status,
			).toBe(204);
			for (const table of [
				"workspaces",
				"workspace_host_trusts",
				"credentials",
				"credential_secrets",
				"guards",
			] as const) {
				const row = backend.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
				expect(row?.count).toBe(0);
			}
		} finally {
			backend.close();
		}
	});

	it("removes global Credential endpoints and rejects the former Workspace request", async () => {
		const backend = createBackend();
		try {
			for (const [method, path] of [
				["GET", "/api/credentials"],
				["POST", "/api/credentials"],
				["GET", "/api/credentials/id-1"],
				["DELETE", "/api/credentials/id-1?expectedRevision=1"],
				["GET", "/api/workspaces/id-1/credential"],
			] as const) {
				expect((await request(backend.handleRequest, method, path)).status).toBe(404);
			}

			const frontendOwnedHostKey = await request(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "workspace",
				environment: "development",
				host: {
					hostname: "localhost",
					port: 22,
					hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:test", verifiedAt: 900 },
				},
				credential: {
					displayName: "root",
					remoteUser: "root",
					type: "password",
					password: "secret",
				},
				defaultCwd: "/tmp",
			});
			expect(frontendOwnedHostKey.status).toBe(400);
			expect(frontendOwnedHostKey.body).toMatchObject({
				error: { code: "validation_error", field: "host.hostKey" },
			});
		} finally {
			backend.close();
		}
	});

	it("keeps backend-owned Guard rule IDs", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			const created = await request(backend.handleRequest, "PATCH", "/api/workspaces/id-1/guard", {
				enabled: true,
				rules: [
					{
						displayName: "Block root deletion",
						pattern: "rm -rf /",
						match: "contains",
						enabled: true,
					},
				],
				expectedRevision: 1,
			});
			expect(created.body).toMatchObject({ rules: [{ id: "id-4" }], revision: 2 });

			const rejected = await request(backend.handleRequest, "PATCH", "/api/workspaces/id-1/guard", {
				enabled: true,
				rules: [
					{
						id: "frontend-generated-id",
						displayName: "Injected rule",
						pattern: "shutdown",
						match: "contains",
						enabled: true,
					},
				],
				expectedRevision: 2,
			});
			expect(rejected.status).toBe(400);
			expect(rejected.body).toMatchObject({ error: { code: "validation_error", field: "rules.id" } });
		} finally {
			backend.close();
		}
	});

	it("preserves Workspace optimistic concurrency and Session deletion rules", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			const forbiddenEdit = await request(backend.handleRequest, "PATCH", "/api/workspaces/id-1", {
				displayName: "renamed",
				expectedRevision: 1,
				host: { hostname: "attacker.invalid" },
			});
			expect(forbiddenEdit.status).toBe(400);
			expect(forbiddenEdit.body).toMatchObject({ error: { code: "validation_error", field: "body.host" } });

			const renamed = await request(backend.handleRequest, "PATCH", "/api/workspaces/id-1", {
				displayName: "renamed",
				expectedRevision: 1,
			});
			expect(renamed.body).toMatchObject({ displayName: "renamed", revision: 2 });
			await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", { displayName: "shell" });
			const blocked = await request(backend.handleRequest, "DELETE", "/api/workspaces/id-1?expectedRevision=2");
			expect(blocked.status).toBe(409);
			expect(blocked.body).toMatchObject({ error: { code: "workspace_has_sessions" } });
			expect((await request(backend.handleRequest, "DELETE", "/api/sessions/id-4?expectedRevision=1")).status).toBe(
				204,
			);
		} finally {
			backend.close();
		}
	});

	it("reopens a v5 file database with owned Credential data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-ssh-agent-"));
		const databasePath = join(directory, "management.sqlite");
		let backend = createBackend(databasePath);
		try {
			await createWorkspace(backend.handleRequest);
			backend.database
				.prepare(`INSERT INTO workspace_host_trusts (workspace_id, algorithm, fingerprint, verified_at)
					VALUES (?, ?, ?, ?)`)
				.run("id-1", "ssh-ed25519", "SHA256:persisted", 950);
			backend.close();
			backend = createBackend(databasePath);

			const tree = await request(backend.handleRequest, "GET", "/api/workspace-session-tree");
			expect(tree.body).toMatchObject({
				workspaces: [
					{
						workspace: {
							id: "id-1",
							activeCredentialId: "id-2",
							host: {
								hostKey: {
									algorithm: "ssh-ed25519",
									fingerprint: "SHA256:persisted",
									verifiedAt: 950,
								},
							},
						},
						sessions: [],
					},
				],
			});
			const credentials = await request(backend.handleRequest, "GET", "/api/workspaces/id-1/credentials");
			expect(credentials.body).toMatchObject({ credentials: [{ id: "id-2", workspaceId: "id-1" }] });
		} finally {
			try {
				backend.close();
			} catch {
				// The first backend may already be closed when reopening fails.
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("migrates existing v4 Workspace host keys into the owned Host Trust table", () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec(`
				PRAGMA foreign_keys = ON;
				CREATE TABLE ssh_agent_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at INTEGER NOT NULL
				) STRICT;
				INSERT INTO ssh_agent_schema_migrations (version, applied_at)
				VALUES (1, 1), (2, 2), (3, 3), (4, 4);
				CREATE TABLE workspaces (
					id TEXT PRIMARY KEY,
					host_key_algorithm TEXT NOT NULL,
					host_key_fingerprint TEXT NOT NULL,
					host_key_verified_at INTEGER NOT NULL
				) STRICT;
				CREATE TABLE sessions (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL REFERENCES workspaces(id),
					display_name TEXT NOT NULL,
					terminal_context_cursor INTEGER NOT NULL DEFAULT 0,
					revision INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) STRICT;
				INSERT INTO workspaces VALUES ('workspace-1', 'ssh-ed25519', 'SHA256:legacy', 800);
			`);
			applyMigrations(database);
			expect(
				database
					.prepare("SELECT algorithm, fingerprint, verified_at FROM workspace_host_trusts WHERE workspace_id = ?")
					.get("workspace-1"),
			).toEqual({ algorithm: "ssh-ed25519", fingerprint: "SHA256:legacy", verified_at: 800 });
			const workspaceColumns = database.prepare("PRAGMA table_info(workspaces)").all();
			expect(workspaceColumns.map((column) => column.name)).toEqual(["id"]);
		} finally {
			database.close();
		}
	});

	it("requires an explicit development rebuild for a v1 database containing data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-ssh-agent-v1-"));
		const databasePath = join(directory, "management.sqlite");
		const database = new DatabaseSync(databasePath);
		try {
			database.exec(`
				CREATE TABLE ssh_agent_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at INTEGER NOT NULL
				) STRICT;
				INSERT INTO ssh_agent_schema_migrations (version, applied_at) VALUES (1, 1000);
				CREATE TABLE credentials (id TEXT PRIMARY KEY) STRICT;
				INSERT INTO credentials (id) VALUES ('legacy-credential');
			`);
		} finally {
			database.close();
		}

		try {
			expect(() => createBackend(databasePath)).toThrow("requires a development rebuild");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function createBackend(databasePath = ":memory:") {
	return createSqliteManagementBackend({
		databasePath,
		credentialEncryptionKey: new Uint8Array(32).fill(7),
		clock: { now: () => 1_000 },
		ids: new SequentialIds(),
		llmModelsFactory: createTestLlmModels,
	});
}

interface CreateWorkspaceOptions {
	displayName?: string;
	credentialDisplayName?: string;
	password?: string;
}

function createWorkspace(
	handleRequest: (request: Request) => Promise<Response>,
	options: CreateWorkspaceOptions = {},
): Promise<{ status: number; body: unknown }> {
	return request(handleRequest, "POST", "/api/workspaces", {
		displayName: options.displayName ?? "workspace",
		environment: "development",
		host: {
			hostname: "localhost",
			port: 22,
		},
		credential: {
			displayName: options.credentialDisplayName ?? "root",
			remoteUser: "root",
			type: "password",
			password: options.password ?? "password",
		},
		defaultCwd: "/tmp",
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
