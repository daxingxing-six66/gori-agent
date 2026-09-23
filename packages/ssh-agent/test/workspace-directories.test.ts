import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { Ssh2ChannelBroker } from "../src/infrastructure/ssh/ssh2-channel-broker.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

async function request(handle: (r: Request) => Promise<Response>, method: string, path: string, body?: unknown) {
 const response = await handle(new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
 return { status: response.status, body: await response.json() };
}

describe("independent workspace directories", () => {
 it("keeps local session inheritance separate from HTTP SFTP and SSH command defaults", async () => {
  const list = vi.spyOn(Ssh2ChannelBroker.prototype, "listDirectory").mockImplementation(async (input) => ({ path: input.remotePath, entries: [] }));
  const execute = vi.spyOn(Ssh2ChannelBroker.prototype, "execute").mockResolvedValue({ exitCode: 0 });
  const backend = createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: new Uint8Array(32).fill(1), llmModelsFactory: createTestLlmModels });
  const call = (method: string, path: string, body?: unknown) => request(backend.handleRequest, method, path, body);
  try {
   const created = await call("POST", "/api/workspaces", { displayName: "paths", environment: "development", host: { hostname: "test.invalid", port: 22 }, credential: { displayName: "test", remoteUser: "test", type: "password", password: "fixture" }, defaultCwd: tmpdir() });
   expect(created.status).toBe(201);
   const id = created.body.workspace.id as string;
   expect(created.body.workspace).toMatchObject({ defaultCwd: tmpdir(), remoteDefaultCwd: "/" });
   backend.database.prepare("INSERT INTO workspace_host_trusts VALUES (?, 'ssh-ed25519', 'SHA256:fixture', 1)").run(id);
   const session = await call("POST", `/api/workspaces/${id}/sessions`, { displayName: "local" });
   expect(session.body.workDir).toBe(await realpath(tmpdir()));
   expect((await call("GET", `/api/workspaces/${id}/sftp/entries`)).body.path).toBe("/");
   expect(list.mock.calls.at(-1)?.[0].target.defaultCwd).toBe("/");
   const changed = await call("PATCH", `/api/workspaces/${id}`, { displayName: "paths", remoteDefaultCwd: "/srv/app", expectedRevision: 1 });
   expect(changed).toMatchObject({ status: 200, body: { defaultCwd: tmpdir(), remoteDefaultCwd: "/srv/app", revision: 2 } });
   expect((await call("GET", `/api/workspaces/${id}/sftp/entries`)).body.path).toBe("/srv/app");
   expect((await call("GET", `/api/workspaces/${id}/sftp/entries?path=%2Fvar`)).body.path).toBe("/var");
   await backend.commandOperations.submit({ sessionId: session.body.id, toolCallId: "default", command: "pwd" });
   expect(execute.mock.calls.at(-1)?.[0].command).toBe("cd -- '/srv/app' && pwd");
   await backend.commandOperations.submit({ sessionId: session.body.id, toolCallId: "explicit", command: "pwd", cwd: "/opt" });
   expect(execute.mock.calls.at(-1)?.[0].command).toBe("cd -- '/opt' && pwd");
   for (const remoteDefaultCwd of ["relative", " ", "~", "/bad\0path"]) {
    expect((await call("PATCH", `/api/workspaces/${id}`, { displayName: "bad", remoteDefaultCwd, expectedRevision: 2 })).status).toBe(400);
   }
   expect((await call("PATCH", `/api/workspaces/${id}`, { displayName: "stale", remoteDefaultCwd: "/wrong", expectedRevision: 1 })).status).toBe(409);
   expect((await call("PATCH", `/api/workspaces/${id}`, { displayName: "rename", expectedRevision: 2 })).body).toMatchObject({ defaultCwd: tmpdir(), remoteDefaultCwd: "/srv/app" });
   expect((await call("GET", `/api/sessions/${session.body.id}`)).body.workDir).toBe(await realpath(tmpdir()));
  } finally { await backend.close(); vi.restoreAllMocks(); }
 });

 it("upgrades historical paths without guessing their host or rewriting session directories", () => {
  const db = new DatabaseSync(":memory:");
  try {
   db.exec("PRAGMA foreign_keys=ON");
   db.exec(readFileSync(new URL("./fixtures/schema-v11.sql", import.meta.url), "utf8"));
   db.exec(`INSERT INTO workspaces VALUES ('w', 'old', 'development', 'remote', 22, '/Users/example/project', 1000, 1000, 3, 5, 1, 2);
    INSERT INTO sessions (id, workspace_id, display_name, revision, created_at, updated_at, work_dir) VALUES ('s', 'w', 'session', 1, 1, 1, '/existing/session');`);
   applyMigrations(db);
   expect(db.prepare("SELECT default_cwd, remote_default_cwd, revision FROM workspaces WHERE id='w'").get()).toEqual({ default_cwd: "/Users/example/project", remote_default_cwd: "/", revision: 5 });
   expect(db.prepare("SELECT work_dir FROM sessions WHERE id='s'").get()?.work_dir).toBe("/existing/session");
   db.exec("UPDATE workspaces SET remote_default_cwd='/srv/custom' WHERE id='w'");
   applyMigrations(db);
   expect(db.prepare("SELECT remote_default_cwd FROM workspaces WHERE id='w'").get()?.remote_default_cwd).toBe("/srv/custom");
   expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
 });
});
