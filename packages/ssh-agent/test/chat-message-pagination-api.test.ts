import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ListChatMessagesResponse } from "../src/api/contracts.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("Chat message pagination HTTP API", () => {
	it("paginates latest, earlier, and later messages without gaps or duplicates", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest);
			insertMixedMessages(backend.database, sessionId);

			const latest = await listMessages(backend.handleRequest, sessionId, "limit=3");
			expectPage(latest, [5, 6, 7], 5, null);

			const earlier = await listMessages(backend.handleRequest, sessionId, "beforeSequence=5&limit=2");
			expectPage(earlier, [3, 4], 3, null);
			const earliest = await listMessages(backend.handleRequest, sessionId, "beforeSequence=3&limit=2");
			expectPage(earliest, [1, 2], null, null);
			expectPage(await listMessages(backend.handleRequest, sessionId, "beforeSequence=1&limit=2"), [], null, null);

			const first = await listMessages(backend.handleRequest, sessionId, "afterSequence=0&limit=3");
			expectPage(first, [1, 2, 3], null, 3);
			const second = await listMessages(backend.handleRequest, sessionId, "afterSequence=3&limit=3");
			expectPage(second, [4, 5, 6], null, 6);
			const last = await listMessages(backend.handleRequest, sessionId, "afterSequence=6&limit=3");
			expectPage(last, [7], null, null);
			expectPage(await listMessages(backend.handleRequest, sessionId, "afterSequence=7&limit=3"), [], null, null);

			expectPage(await listMessages(backend.handleRequest, sessionId, "limit=7"), [1, 2, 3, 4, 5, 6, 7], null, null);
			expectPage(
				await listMessages(backend.handleRequest, sessionId, "beforeSequence=999&limit=10"),
				[1, 2, 3, 4, 5, 6, 7],
				null,
				null,
			);
			expect(latest.messages.map((message) => message.message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(earlier.messages.map((message) => message.message.role)).toEqual(["toolResult", "compactionSummary"]);
		} finally {
			await backend.close();
		}
	});

	it("returns legacy cards only with their anchor group, in both pagination directions", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest); insertMixedMessages(backend.database, sessionId);
			insertLegacy(backend.database, sessionId, "legacy-a", "failed", 3);
			insertLegacy(backend.database, sessionId, "legacy-b", "success", 3);
			const before = backend.database.prepare("SELECT id, sequence, message_json FROM chat_messages WHERE session_id = ? ORDER BY sequence").all(sessionId);
			expectPage(await listMessages(backend.handleRequest, sessionId, "limit=2"), [6, 7], 6, null);
			const page = await listMessages(backend.handleRequest, sessionId, "beforeSequence=5&limit=2");
			expectPage(page, [3, 3, 3, 4], 3, null);
			expect(page.messages.map((m) => m.id)).toEqual(["message-3", "deployment:legacy-a", "deployment:legacy-b", "message-4"]);
			expect(page.messages.slice(1, 3).map((m) => m.historyOrder)).toEqual([1, 1]);
			expect(page.messages[1]?.message).toMatchObject({ role: "custom", customType: "deployment", details: { title: "API", outcome: "failed", startedAt: 1, finishedAt: 3 } });
			const forward = await listMessages(backend.handleRequest, sessionId, "afterSequence=2&limit=1");
			expectPage(forward, [3, 3, 3], null, 3);
			expectPage(await listMessages(backend.handleRequest, sessionId, "afterSequence=3&limit=1"), [4], null, 4);
			expect(backend.database.prepare("SELECT id, sequence, message_json FROM chat_messages WHERE session_id = ? ORDER BY sequence").all(sessionId)).toEqual(before);
			expectPage(await listMessages(backend.handleRequest, "another-session", "limit=100"), [], null, null);
		} finally { await backend.close(); }
	});

	it("prefers a formal message and relocates an old backfilled message on the server", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest); insertMixedMessages(backend.database, sessionId);
			insertLegacy(backend.database, sessionId, "formal", "success", 3);
			const message = { role: "custom", customType: "deployment", display: true, content: "Formal API", timestamp: 1,
				details: { deploymentId: "formal", title: "Formal API", position: "legacy_finished", outcome: "success", startedAt: 1, finishedAt: 3 } };
			backend.database.prepare("INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at) VALUES (?, ?, NULL, 8, 'deployment', ?, 1)").run("deployment:formal", sessionId, JSON.stringify(message));
			const page = await listMessages(backend.handleRequest, sessionId, "limit=100");
			expect(page.messages.filter((m) => m.message.role === "custom")).toHaveLength(1);
			expect(page.messages.map((m) => m.id)).toEqual(["message-1", "message-2", "message-3", "deployment:formal", "message-4", "message-5", "message-6", "message-7"]);
			expect(page.messages[3]).toMatchObject({ id: "deployment:formal", sequence: 3, historyOrder: 1, message: { details: { position: "history" } } });
			expectPage(await listMessages(backend.handleRequest, sessionId, "afterSequence=3&limit=100"), [4, 5, 6, 7], null, null);
		} finally { await backend.close(); }
	});

	it("projects current formal card status without returning the deployment plan", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest); insertMixedMessages(backend.database, sessionId);
			insertLegacy(backend.database, sessionId, "formal-current", "success", 3);
			const message = { role: "custom", customType: "deployment", display: true, content: "API", timestamp: 1,
				details: { deploymentId: "formal-current", title: "API" } };
			backend.database.prepare("INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at) VALUES (?, ?, NULL, 8, 'deployment', ?, 1)").run("deployment:formal-current", sessionId, JSON.stringify(message));
			const page = await listMessages(backend.handleRequest, sessionId, "limit=100");
			expect(page.messages.filter((m) => m.message.role === "custom")).toHaveLength(1);
			expect(page.messages.at(-1)).toMatchObject({ sequence: 8, message: { details: { status: "success" } } });
			expect(JSON.stringify(page)).not.toContain('"plan":');
		} finally { await backend.close(); }
	});

	it("includes an orphan active discussion without inventing stages or duplicating a planned discussion", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest); insertMixedMessages(backend.database, sessionId);
			const workspace = backend.database.prepare("SELECT workspace_id FROM sessions WHERE id = ?").get(sessionId)!;
			backend.database.prepare("INSERT INTO deployment_discussions (id, session_id, workspace_id, status, revision, snapshot_json, created_at, updated_at) VALUES ('discussion', ?, ?, 'discussing', 1, ?, 4, 4)")
				.run(sessionId, workspace.workspace_id!, JSON.stringify({ module: { name: "Worker" } }));
			let page = await listMessages(backend.handleRequest, sessionId, "limit=100");
			expect(page.messages.find((m) => m.id === "deployment:discussion")).toMatchObject({ sequence: 3, message: { details: { status: "discussing", title: "Worker" } } });
			insertLegacy(backend.database, sessionId, "planned", "failed", 6, "discussion");
			page = await listMessages(backend.handleRequest, sessionId, "limit=100");
			expect(page.messages.filter((m) => m.message.role === "custom").map((m) => m.id)).toEqual(["deployment:planned"]);
		} finally { await backend.close(); }
	});

	it("can return a legacy-only history anchored before the first real Chat message", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest); insertLegacy(backend.database, sessionId, "only", "cancelled", 3);
			const page = await listMessages(backend.handleRequest, sessionId, "limit=1");
			expectPage(page, [0], null, null);
			expect(page.messages[0]).toMatchObject({ id: "deployment:only", historyOrder: 1 });
		} finally { await backend.close(); }
	});

	it("returns empty cursor fields for empty and unknown Sessions", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest);
			expectPage(await listMessages(backend.handleRequest, sessionId, ""), [], null, null);
			expectPage(await listMessages(backend.handleRequest, "missing-session", ""), [], null, null);
		} finally {
			await backend.close();
		}
	});

	it("rejects conflicting and invalid pagination parameters", async () => {
		const backend = createBackend();
		try {
			const sessionId = await createSession(backend.handleRequest);
			const root = `/api/sessions/${sessionId}/chat/messages?`;
			const conflict = await request(backend.handleRequest, "GET", `${root}beforeSequence=3&afterSequence=1`);
			expect(conflict).toEqual({
				status: 400,
				body: {
					error: {
						code: "validation_error",
						message: "字段 beforeSequence 的值无效",
						field: "beforeSequence",
						errorId: expect.any(String),
					},
				},
			});

			for (const [query, field] of [
				["beforeSequence=-1", "beforeSequence"],
				["afterSequence=1.5", "afterSequence"],
				["afterSequence=9007199254740992", "afterSequence"],
				["limit=0", "limit"],
				["limit=101", "limit"],
			] as const) {
				const result = await request(backend.handleRequest, "GET", `${root}${query}`);
				expect(result).toMatchObject({
					status: 400,
					body: { error: { code: "validation_error", field } },
				});
			}
		} finally {
			await backend.close();
		}
	});
});

function createBackend() {
	return createSqliteManagementBackend({
		databasePath: ":memory:",
		credentialEncryptionKey: new Uint8Array(32).fill(7),
		llmModelsFactory: createTestLlmModels,
	});
}

async function createSession(handleRequest: (request: Request) => Promise<Response>): Promise<string> {
	const workspace = await request(handleRequest, "POST", "/api/workspaces", {
		displayName: "workspace",
		environment: "development",
		host: { hostname: "localhost", port: 22 },
		credential: { displayName: "root", remoteUser: "root", type: "password", password: "password" },
		defaultCwd: "/tmp",
	});
	const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
	const session = await request(handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
		displayName: "session",
	});
	return (session.body as { id: string }).id;
}

function insertMixedMessages(database: DatabaseSync, sessionId: string): void {
	const fixtures = [
		{ type: "user", message: { role: "user", content: "one", timestamp: 1 } },
		{
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "two" }],
				api: "openai-completions",
				provider: "faux",
				model: "model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "stop",
				timestamp: 2,
			},
		},
		{
			type: "tool",
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "three" }],
				isError: false,
				timestamp: 3,
			},
		},
		{
			type: "compact",
			message: { role: "compactionSummary", summary: "four", tokensBefore: 100, timestamp: 4 },
		},
		{ type: "user", message: { role: "user", content: "five", timestamp: 5 } },
		{
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "six" }],
				api: "openai-completions",
				provider: "faux",
				model: "model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "stop",
				timestamp: 6,
			},
		},
		{
			type: "tool",
			message: {
				role: "toolResult",
				toolCallId: "tool-2",
				toolName: "bash",
				content: [{ type: "text", text: "seven" }],
				isError: false,
				timestamp: 7,
			},
		},
	] as const;
	const insert = database.prepare(
		"INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, provider, usage_json, message_json, created_at) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?)",
	);
	for (const [index, fixture] of fixtures.entries()) {
		const sequence = index + 1;
		insert.run(`message-${sequence}`, sessionId, sequence, fixture.type, JSON.stringify(fixture.message), sequence);
	}
}

async function listMessages(
	handleRequest: (request: Request) => Promise<Response>,
	sessionId: string,
	query: string,
): Promise<ListChatMessagesResponse> {
	const suffix = query === "" ? "" : `?${query}`;
	const result = await request(handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages${suffix}`);
	expect(result.status).toBe(200);
	return result.body as ListChatMessagesResponse;
}

function expectPage(
	page: ListChatMessagesResponse,
	sequences: number[],
	nextBeforeSequence: number | null,
	nextSequence: number | null,
): void {
	expect(page.messages.map((message) => message.sequence)).toEqual(sequences);
	expect(page.nextBeforeSequence).toBe(nextBeforeSequence);
	expect(page.nextSequence).toBe(nextSequence);
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
	return { status: response.status, body: await response.json() };
}

function insertLegacy(database: DatabaseSync, sessionId: string, id: string, status: "success" | "failed" | "cancelled", finishedAt: number, discussionId?: string): void {
	const workspace = database.prepare("SELECT workspace_id FROM sessions WHERE id = ?").get(sessionId)!;
	database.prepare("INSERT INTO deployment_runs (id, session_id, workspace_id, status, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
		.run(id, sessionId, workspace.workspace_id!, status, JSON.stringify({ plan: { module: { name: "API" } }, startedAt: 1, finishedAt, ...(discussionId ? { discussionId } : {}) }), finishedAt);
}
