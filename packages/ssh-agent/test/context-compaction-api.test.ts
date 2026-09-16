import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { IdGenerator } from "../src/domain/ids.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

class SequentialIds implements IdGenerator {
	#next = 1;

	next(): string {
		const id = `id-${this.#next}`;
		this.#next += 1;
		return id;
	}
}

describe("context compaction HTTP API", () => {
	it("reads and atomically replaces the global compaction settings", async () => {
		const backend = createBackend();
		try {
			const initial = await request(backend.handleRequest, "GET", "/api/settings/compaction");
			expect(initial).toMatchObject({
				status: 200,
				body: { triggerPercent: 80, model: null, revision: 1, updatedAt: expect.any(Number) },
			});

			const updated = await request(backend.handleRequest, "PUT", "/api/settings/compaction?expectedRevision=1", {
				triggerPercent: 75,
				model: { providerId: "anthropic", modelId: "claude-sonnet-test" },
			});
			expect(updated).toEqual({
				status: 200,
				body: {
					triggerPercent: 75,
					model: { providerId: "anthropic", modelId: "claude-sonnet-test" },
					revision: 2,
					updatedAt: 1_000,
				},
			});

			const stale = await request(backend.handleRequest, "PUT", "/api/settings/compaction?expectedRevision=1", {
				triggerPercent: 70,
				model: null,
			});
			expect(stale).toMatchObject({ status: 409, body: { error: { code: "revision_conflict" } } });
		} finally {
			await backend.close();
		}
	});

	it("validates the threshold and configured model", async () => {
		const backend = createBackend();
		try {
			const fractional = await request(backend.handleRequest, "PUT", "/api/settings/compaction?expectedRevision=1", {
				triggerPercent: 80.5,
				model: null,
			});
			expect(fractional).toMatchObject({
				status: 400,
				body: { error: { code: "validation_error", field: "triggerPercent" } },
			});
			const unknownModel = await request(
				backend.handleRequest,
				"PUT",
				"/api/settings/compaction?expectedRevision=1",
				{ triggerPercent: 80, model: { providerId: "anthropic", modelId: "missing" } },
			);
			expect(unknownModel).toMatchObject({
				status: 404,
				body: { error: { code: "not_found", field: "model" } },
			});
		} finally {
			await backend.close();
		}
	});

	it("skips a manual compaction when the session has no messages", async () => {
		const backend = createBackend();
		try {
			const workspace = await request(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "workspace",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "password" },
				defaultCwd: "/tmp",
			});
			const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
			const session = await request(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "session",
			});
			const sessionId = (session.body as { id: string }).id;

			const result = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/compactions`);

			expect(result).toEqual({
				status: 200,
				body: { status: "skipped", reason: "nothing_to_compact", attempts: 0, contextUsage: null },
			});
		} finally {
			await backend.close();
		}
	});
});

describe("context compaction migration", () => {
	it("backfills split message columns and removes the obsolete entry table", () => {
		const database = new DatabaseSync(":memory:");
		try {
			applyMigrations(database);
			database.exec("PRAGMA foreign_keys = OFF");
			database.exec(`
				DROP TABLE chat_compaction_settings;
				ALTER TABLE chat_messages RENAME TO chat_messages_v12_current;
				CREATE TABLE chat_messages (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
					run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
					sequence INTEGER NOT NULL,
					message_json TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					UNIQUE(session_id, sequence)
				) STRICT;
				DROP TABLE chat_messages_v12_current;
				CREATE TABLE agent_session_entries (
					session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
					id TEXT NOT NULL,
					sequence INTEGER NOT NULL,
					entry_json TEXT NOT NULL,
					PRIMARY KEY(session_id, id),
					UNIQUE(session_id, sequence)
				) STRICT;
				DELETE FROM ssh_agent_schema_migrations WHERE version = 12;
			`);
			const insert = database.prepare(
				"INSERT INTO chat_messages (id, session_id, run_id, sequence, message_json, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
			);
			insert.run("user", "missing-session", 1, JSON.stringify({ role: "user", content: "hello" }), 1);
			insert.run(
				"assistant",
				"missing-session",
				2,
				JSON.stringify({
					role: "assistant",
					provider: "anthropic",
					usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 },
				}),
				2,
			);
			insert.run("tool", "missing-session", 3, JSON.stringify({ role: "toolResult" }), 3);
			insert.run("compact", "missing-session", 4, JSON.stringify({ role: "compactionSummary" }), 4);

			applyMigrations(database);

			const rows = database
				.prepare("SELECT id, message_type, provider, usage_json FROM chat_messages ORDER BY sequence")
				.all() as Array<Record<string, unknown>>;
			expect(rows).toEqual([
				{ id: "user", message_type: "user", provider: null, usage_json: null },
				{
					id: "assistant",
					message_type: "assistant",
					provider: "anthropic",
					usage_json: JSON.stringify({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19 }),
				},
				{ id: "tool", message_type: "tool", provider: null, usage_json: null },
				{ id: "compact", message_type: "compact", provider: null, usage_json: null },
			]);
			expect(
				database
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_session_entries'")
					.get(),
			).toBeUndefined();
			expect(database.prepare("SELECT trigger_percent, revision FROM chat_compaction_settings").get()).toEqual({
				trigger_percent: 80,
				revision: 1,
			});
		} finally {
			database.close();
		}
	});
});

function createBackend() {
	return createSqliteManagementBackend({
		databasePath: ":memory:",
		credentialEncryptionKey: new Uint8Array(32).fill(7),
		clock: { now: () => 1_000 },
		ids: new SequentialIds(),
		llmModelsFactory: createTestLlmModels,
	});
}

interface HttpResult {
	status: number;
	body: unknown;
}

async function request(
	handleRequest: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<HttpResult> {
	const response = await handleRequest(
		new Request(`http://localhost${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}
