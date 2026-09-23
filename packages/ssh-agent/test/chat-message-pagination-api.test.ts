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
