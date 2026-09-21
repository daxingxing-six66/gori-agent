import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, type, release, arch } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ChatPromptService } from "../src/application/services/chat-prompt-service.ts";
import { SqliteChatPromptRepository } from "../src/infrastructure/sqlite/sqlite-chat-prompt-repository.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { SqliteWorkspaceRepository } from "../src/infrastructure/sqlite/sqlite-workspace-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

type Backend = ReturnType<typeof createSqliteManagementBackend>;
async function setup(api?: string) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "gori-prompt-")));
	const captured: Context[] = [];
	const faux = fauxProvider({ api, provider: "prompt-test", models: [{ id: "model", contextWindow: 128_000 }] });
	faux.setResponses(Array.from({ length: 6 }, () => (context: Context) => {
		captured.push(JSON.parse(JSON.stringify(context)) as Context);
		return fauxAssistantMessage("done");
	}));
	const start = () => createSqliteManagementBackend({
		databasePath: join(directory, "test.sqlite"),
		credentialEncryptionKey: Buffer.alloc(32, 23), localCwd: directory,
		llmModelsFactory: (credentials) => {
			const models = createModels({ credentials });
			models.setProvider(faux.provider);
			return models;
		},
	});
	let backend = start();
	const workspaceResponse = await request(backend, "/api/workspaces", {
		displayName: "excluded-workspace-name", environment: "development",
		host: { hostname: "192.0.2.10", port: 2222 }, defaultCwd: "/excluded-remote-cwd",
		credential: { displayName: "test", remoteUser: "test", type: "password", password: "excluded-secret" },
	});
	const { workspace } = await workspaceResponse.json() as { workspace: { id: string } };
	const response = await request(backend, `/api/workspaces/${workspace.id}/sessions`, { displayName: "chat", workDir: directory });
	const { id: sessionId } = await response.json() as { id: string };
	expect(response.status).toBe(201);
	return {
		get backend() { return backend; }, sessionId, workspaceId: workspace.id, directory, captured, faux,
		async restart() { await backend.close(); backend = start(); },
		async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); },
	};
}
function request(backend: Backend, path: string, body: unknown, locale = "en-US") {
	return backend.handleRequest(new Request(`http://localhost${path}`, {
		method: "POST", headers: { "content-type": "application/json", "accept-language": locale },
		body: JSON.stringify(body),
	}));
}
async function run(fixture: Awaited<ReturnType<typeof setup>>, id: string) {
	const response = await request(fixture.backend, `/api/sessions/${fixture.sessionId}/chat/runs`, {
		requestId: id, providerId: "prompt-test", modelId: "model", message: "<terminal-model-on>",
		serverInteractionMode: "command",
	});
	expect(response.status).toBe(201);
	for (let i = 0; i < 200; i++) {
		const active = await fixture.backend.handleRequest(new Request(`http://localhost/api/sessions/${fixture.sessionId}/chat/runs/active`));
		if ((await active.json() as { run: unknown }).run === null) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Run did not complete");
}
function insertTerminal(fixture: Awaited<ReturnType<typeof setup>>, id = "terminal-1") {
	fixture.backend.database.prepare(`INSERT INTO terminal_sessions
		(id, session_id, workspace_id, open_request_id, status, revision, term, rows, cols,
		last_event_sequence, ownership_epoch, last_consumer_activity_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'opening', 1, 'xterm-256color', 40, 160, 0, 0, 1, 1, 1)`)
		.run(id, fixture.sessionId, fixture.workspaceId, id);
}
function transition(fixture: Awaited<ReturnType<typeof setup>>, status: string, id = "terminal-1") {
	fixture.backend.database.prepare("UPDATE terminal_sessions SET status = ?, revision = revision + 1, updated_at = updated_at + 1 WHERE id = ?")
		.run(status, id);
}
function modeMessages(fixture: Awaited<ReturnType<typeof setup>>) {
	return new SqliteChatRepository(fixture.backend.database).listMessages(fixture.sessionId)
		.map((entry) => entry.message).filter((message) => message.role === "system");
}

describe("session prompt snapshots and terminal mode history", () => {
	it("initializes at the first Run, preserves the request prefix and survives restart", async () => {
		const fixture = await setup();
		try {
			const repository = new SqliteChatPromptRepository(fixture.backend.database);
			expect(repository.find(fixture.sessionId)).toBeUndefined();
			const usage = await fixture.backend.handleRequest(new Request(`http://localhost/api/sessions/${fixture.sessionId}/chat/context-usage`));
			expect(await usage.json()).toEqual({ contextUsage: null });
			await run(fixture, "first");
			const snapshot = repository.find(fixture.sessionId)!;
			expect(snapshot.systemPrompt).toContain(JSON.stringify(fixture.directory));
			expect(snapshot.systemPrompt).toContain(`${type()} ${release()} (${arch()})`);
			expect(snapshot.systemPrompt).toContain('"host":"192.0.2.10","port":2222');
			for (const excluded of ["excluded-workspace-name", "/excluded-remote-cwd", "excluded-secret"]) {
				expect(snapshot.systemPrompt).not.toContain(excluded);
			}
			expect(fixture.captured[0]!.messages.map((message) => message.role)).toEqual(["system", "user"]);
			expect(fixture.captured[0]!.messages[0]).toMatchObject({ content: [{ type: "text", text: "<terminal-model-off>" }] });
			expect(repository.createOnce({ ...snapshot, systemPrompt: "replacement" })).toEqual(snapshot);
			expect(() => fixture.backend.database.prepare("UPDATE chat_prompt_snapshots SET system_prompt = ? WHERE session_id = ?")
				.run("replacement", fixture.sessionId)).toThrow("immutable");
			await fixture.restart();
			await run(fixture, "second");
			expect(new SqliteChatPromptRepository(fixture.backend.database).find(fixture.sessionId)).toEqual(snapshot);
			expect(fixture.captured[1]!.systemPrompt).toBe(fixture.captured[0]!.systemPrompt);
			expect(fixture.captured[1]!.tools).toEqual(fixture.captured[0]!.tools);
			expect(fixture.captured[1]!.messages.slice(0, 2)).toEqual(fixture.captured[0]!.messages);
			expect(modeMessages(fixture)).toHaveLength(1);
			const prompts = new ChatPromptService(new SqliteChatPromptRepository(fixture.backend.database), {
				findById: async () => { throw new Error("Must not read changed environment"); },
			});
			const session = await new SqliteSessionRepository(fixture.backend.database).findById(fixture.sessionId);
			expect(await prompts.initialize(session!, "/changed-local-directory")).toBe(snapshot.systemPrompt);
		} finally { await fixture.dispose(); }
	});

	it("appends transitions atomically, ignores failed opens and resize, and records restart loss once", async () => {
		const fixture = await setup();
		try {
			insertTerminal(fixture, "failed"); transition(fixture, "failed", "failed");
			expect(modeMessages(fixture)).toEqual([]);
			insertTerminal(fixture);
			transition(fixture, "active"); transition(fixture, "active");
			expect(new SqliteChatPromptRepository(fixture.backend.database).find(fixture.sessionId)).toBeUndefined();
			const compact = await request(fixture.backend, `/api/sessions/${fixture.sessionId}/chat/compactions`, {});
			expect(compact.status).toBe(409);
			expect(await compact.json()).toMatchObject({ error: { code: "chat_prompt_not_initialized" } });
			expect(new SqliteChatPromptRepository(fixture.backend.database).find(fixture.sessionId)).toBeUndefined();
			const prompts = new ChatPromptService(new SqliteChatPromptRepository(fixture.backend.database), new SqliteWorkspaceRepository(fixture.backend.database));
			const session = await new SqliteSessionRepository(fixture.backend.database).findById(fixture.sessionId);
			const snapshot = await prompts.initialize(session!, fixture.directory);
			expect(modeMessages(fixture)).toHaveLength(1);
			fixture.backend.database.exec(`CREATE TRIGGER fail_mode_message BEFORE INSERT ON chat_messages
				WHEN NEW.message_type = 'system' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
			expect(() => transition(fixture, "closing")).toThrow("injected failure");
			expect(new SqliteTerminalRepository(fixture.backend.database).findSession("terminal-1")?.status).toBe("active");
			expect(modeMessages(fixture)).toHaveLength(1);
			fixture.backend.database.exec("DROP TRIGGER fail_mode_message");
			transition(fixture, "closing"); transition(fixture, "closed");
			insertTerminal(fixture, "terminal-2"); transition(fixture, "active", "terminal-2");
			await fixture.restart();
			new SqliteTerminalRepository(fixture.backend.database).recoverInterrupted(Date.now());
			expect(modeMessages(fixture).map((message) => message.content)).toEqual(
				["on", "off", "on", "off"].map((mode) => [{ type: "text", text: `<terminal-model-${mode}>` }]),
			);
			expect(new SqliteChatPromptRepository(fixture.backend.database).find(fixture.sessionId)?.systemPrompt).toBe(snapshot);
			await run(fixture, "after-terminal");
			expect(fixture.captured[0]!.messages.filter((message) => message.role === "system")).toHaveLength(4);
			expect(fixture.captured[0]!.systemPrompt).toBe(snapshot);
		} finally { await fixture.dispose(); }
	});

	it("rejects APIs without chronological system roles before making a Run, in both locales", async () => {
		const fixture = await setup("unsupported-test-api");
		try {
			for (const locale of ["en-US", "zh-CN"]) {
				const response = await request(fixture.backend, `/api/sessions/${fixture.sessionId}/chat/runs`, {
					requestId: locale, providerId: "prompt-test", modelId: "model", message: "hello", serverInteractionMode: "command",
				}, locale);
				expect(response.status).toBe(409);
				const { error } = await response.json() as { error: { code: string; message: string } };
				expect(error.code).toBe("chat_system_messages_unsupported");
				expect(error.message).toContain(locale === "en-US" ? "system" : "当前模型接口");
			}
			expect(fixture.faux.state.callCount).toBe(0);
			expect(new SqliteChatPromptRepository(fixture.backend.database).find(fixture.sessionId)).toBeUndefined();
			expect(fixture.backend.database.prepare("SELECT count(*) AS count FROM chat_runs").get()?.count).toBe(0);
		} finally { await fixture.dispose(); }
	});
});
