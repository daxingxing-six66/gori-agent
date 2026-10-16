import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { LandlockRemoteSandboxProvider } from "../src/infrastructure/sandbox/landlock-remote-sandbox-provider.ts";
import { wrapRemoteCommand } from "../src/infrastructure/sandbox/shell-command.ts";
import { Ssh2ChannelBroker } from "../src/infrastructure/ssh/ssh2-channel-broker.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

async function request(handle: (r: Request) => Promise<Response>, method: string, path: string, body?: unknown) {
	const response = await handle(new Request(`http://localhost${path}`, { method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
	return { status: response.status, body: await response.json() };
}

describe("workspace directory boundaries", () => {
	it("removes the old directory column while retaining independently migrated sandbox roots and audit facts", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(readFileSync(new URL("./fixtures/schema-v27-sandbox.sql", import.meta.url), "utf8"));
			const before = db.prepare("SELECT id, revision, default_cwd FROM workspaces ORDER BY id").all();
			const sessions = db.prepare("SELECT id, work_dir, sandbox_enabled, revision FROM sessions ORDER BY id").all();
			const audit = db.prepare("SELECT id, sandbox_json FROM command_operations ORDER BY id").all();
			applyMigrations(db);
			expect(db.prepare("PRAGMA table_info(workspaces)").all().some((row) => row.name === "remote_default_cwd")).toBe(false);
			expect(db.prepare("SELECT id, revision, default_cwd FROM workspaces ORDER BY id").all()).toEqual(before);
			expect(db.prepare("SELECT id, work_dir, sandbox_enabled, revision FROM sessions ORDER BY id").all()).toEqual(sessions);
			expect(db.prepare("SELECT id, sandbox_json FROM command_operations ORDER BY id").all()).toEqual(audit);
			expect(db.prepare("SELECT sandbox_writable_roots_json FROM workspaces WHERE id='w-app'").get()?.sandbox_writable_roots_json).toBe('["/srv/link/../app "]');
			const migrated = db.prepare("SELECT * FROM ssh_agent_schema_migrations ORDER BY version").all();
			applyMigrations(db);
			expect(db.prepare("SELECT * FROM ssh_agent_schema_migrations ORDER BY version").all()).toEqual(migrated);
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally { db.close(); }
	});

	it("keeps local inheritance, starts SFTP at / and commands at SSH home, and rejects the removed API field", async () => {
		const list = vi.spyOn(Ssh2ChannelBroker.prototype, "listDirectory").mockImplementation(async (input) => ({ path: input.remotePath, entries: [] }));
		vi.spyOn(LandlockRemoteSandboxProvider.prototype, "prepare").mockImplementation(async ({ cwd, command }) => ({ command: wrapRemoteCommand(cwd, command),
			sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: "/srv/app" }, confirmation: "test-confirmation\n" }));
		const execute = vi.spyOn(Ssh2ChannelBroker.prototype, "execute").mockImplementation(async (input) => {
			await input.onStderr(Buffer.from("test-confirmation\n")); return { exitCode: 0 };
		});
		const backend = createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: new Uint8Array(32).fill(1), llmModelsFactory: createTestLlmModels });
		const call = (method: string, path: string, body?: unknown) => request(backend.handleRequest, method, path, body);
		try {
			const input = { displayName: "paths", environment: "development", host: { hostname: "test.invalid", port: 22 },
				credential: { displayName: "test", remoteUser: "test", type: "password", password: "fixture" }, defaultCwd: tmpdir(), sandboxWritableRoots: ["/srv/app"] };
			expect((await call("POST", "/api/workspaces", { ...input, remoteDefaultCwd: "/root" })).status).toBe(400);
			const created = await call("POST", "/api/workspaces", input);
			expect(created.status).toBe(201);
			const id = created.body.workspace.id as string;
			expect(created.body.workspace).not.toHaveProperty("remoteDefaultCwd");
			backend.database.prepare("INSERT INTO workspace_host_trusts VALUES (?, 'ssh-ed25519', 'SHA256:fixture', 1)").run(id);
			const session = await call("POST", `/api/workspaces/${id}/sessions`, { displayName: "local" });
			expect(session.body.workDir).toBe(await realpath(tmpdir()));
			expect((await call("GET", `/api/workspaces/${id}/sftp/entries`)).body.path).toBe("/");
			expect(list.mock.calls.at(-1)?.[0].target).not.toHaveProperty("defaultCwd");
			expect((await call("GET", `/api/workspaces/${id}/sftp/entries?path=%2Fvar`)).body.path).toBe("/var");
			await backend.commandOperations.submit({ sessionId: session.body.id, toolCallId: "default", command: "pwd" });
			expect(execute.mock.calls.at(-1)?.[0].command).toBe(wrapRemoteCommand("~", "pwd"));
			await backend.commandOperations.submit({ sessionId: session.body.id, toolCallId: "explicit", command: "pwd", cwd: "/opt" });
			expect(execute.mock.calls.at(-1)?.[0].command).toBe(wrapRemoteCommand("/opt", "pwd"));
			const rejected = await call("PATCH", `/api/workspaces/${id}`, { displayName: "bad", remoteDefaultCwd: "/root", expectedRevision: 1 });
			expect(rejected).toMatchObject({ status: 400, body: { error: { field: "body.remoteDefaultCwd" } } });
			expect((await call("PATCH", `/api/workspaces/${id}`, { displayName: "renamed", expectedRevision: 1 })).body)
				.toMatchObject({ defaultCwd: tmpdir(), sandboxWritableRoots: ["/srv/app"], revision: 2 });
		} finally { await backend.close(); vi.restoreAllMocks(); }
	});

	it("upgrades frozen v11 paths without guessing their host or changing Session directories", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.exec(readFileSync(new URL("./fixtures/schema-v11.sql", import.meta.url), "utf8"));
			db.exec(`INSERT INTO workspaces VALUES ('w', 'old', 'development', 'remote', 22, '/Users/example/project', 1000, 1000, 3, 5, 1, 2);
				INSERT INTO sessions (id, workspace_id, display_name, revision, created_at, updated_at, work_dir) VALUES ('s', 'w', 'session', 1, 1, 1, '/existing/session');`);
			applyMigrations(db);
			expect(db.prepare("SELECT default_cwd, revision, sandbox_writable_roots_json FROM workspaces WHERE id='w'").get())
				.toEqual({ default_cwd: "/Users/example/project", revision: 5, sandbox_writable_roots_json: "[]" });
			expect(db.prepare("SELECT work_dir FROM sessions WHERE id='s'").get()?.work_dir).toBe("/existing/session");
			expect(db.prepare("PRAGMA table_info(workspaces)").all().some((row) => row.name === "remote_default_cwd")).toBe(false);
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally { db.close(); }
	});
});
