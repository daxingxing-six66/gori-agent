import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DefaultSshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import { RemoteCommandExecutionPlan } from "../src/application/tools/remote-command-execution-plan.ts";
import { requireSandboxWritableRoots } from "../src/application/sandbox-writable-roots.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteWorkspaceRepository } from "../src/infrastructure/sqlite/sqlite-workspace-repository.ts";
import { SqliteCredentialRepository } from "../src/infrastructure/sqlite/sqlite-credential-repository.ts";
import { readStoredCommandSandbox } from "../src/infrastructure/sqlite/stored-command-sandbox.ts";
import { readStoredTerminalSandbox } from "../src/infrastructure/sqlite/stored-terminal-sandbox.ts";
import { readStoredSandboxWritableRoots } from "../src/infrastructure/sqlite/stored-sandbox-writable-roots.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import type { CreateWorkspaceInput } from "../src/domain/workspace.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

const roots = ["/srv/app", "/var/log/app"];
const input: CreateWorkspaceInput = { displayName: "test", environment: "development",
	host: { hostname: "fixture.invalid", port: 22 }, defaultCwd: tmpdir(), remoteDefaultCwd: "/srv/app",
	credential: { displayName: "fixture", remoteUser: "fixture", secret: { type: "password", password: "synthetic" } },
	sandboxWritableRoots: roots };
const backendFor = (databasePath = ":memory:") => createSqliteManagementBackend({ databasePath,
	credentialEncryptionKey: new Uint8Array(32).fill(1), llmModelsFactory: createTestLlmModels });
function targetsFor(database: DatabaseSync) {
	return new DefaultSshTargetResolver({ sessions: new SqliteSessionRepository(database), workspaces: new SqliteWorkspaceRepository(database),
		credentials: new SqliteCredentialRepository(database), hostTrust: { ensureTrusted: async () => ({ algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", verifiedAt: 1 }) } });
}

describe("sandbox writable directory configuration", () => {
	it("copies Workspace defaults once, isolates Session edits and resolves the Session's complete list", async () => {
		const backend = backendFor();
		try {
			const { workspace } = await backend.api.createWorkspace(input);
			const first = await backend.api.createSession({ workspaceId: workspace.id, displayName: "first" });
			const other = await backend.api.createSession({ workspaceId: workspace.id, displayName: "other" });
			expect(first.sandboxWritableRoots).toEqual(roots);
			await backend.api.renameSession({ id: first.id, sandboxWritableRoots: ["/etc/app", "/srv/app"], expectedRevision: 1 });
			await backend.api.updateWorkspace({ id: workspace.id, displayName: "changed", sandboxWritableRoots: ["/srv/new"], expectedRevision: 1 });
			expect((await backend.api.getSession(other.id)).sandboxWritableRoots).toEqual(roots);
			expect((await backend.api.createSession({ workspaceId: workspace.id, displayName: "new" })).sandboxWritableRoots).toEqual(["/srv/new"]);
			const resolver = targetsFor(backend.database);
			expect(await resolver.resolve(first.id)).toMatchObject({ defaultCwd: "/srv/app", sandboxWritableRoots: ["/etc/app", "/srv/app"] });
			expect(await resolver.resolveWorkspace(workspace.id)).toMatchObject({ defaultCwd: "/srv/app", sandboxWritableRoots: ["/srv/new"] });
			await expect(backend.api.renameSession({ id: first.id, sandboxWritableRoots: ["/wrong"], expectedRevision: 1 })).rejects.toMatchObject({ code: "revision_conflict" });
			expect((await backend.api.getSession(first.id)).sandboxWritableRoots).toEqual(["/etc/app", "/srv/app"]);
		} finally { await backend.close(); }
	});

	it("accepts remote cwd / without granting / writes and accepts a per-Session override at creation", async () => {
		const backend = backendFor();
		try {
			const { workspace } = await backend.api.createWorkspace({ ...input, remoteDefaultCwd: "/" });
			const session = await backend.api.createSession({ workspaceId: workspace.id, displayName: "custom", sandboxWritableRoots: ["/etc/app"] });
			expect(await targetsFor(backend.database).resolve(session.id)).toMatchObject({ defaultCwd: "/", sandboxWritableRoots: ["/etc/app"] });
		} finally { await backend.close(); }
	});

	it("preserves legacy one-directory defaults without treating cwd changes as write authorization", async () => {
		const backend = backendFor();
		try {
			const { workspace } = await backend.api.createWorkspace({ ...input, sandboxWritableRoots: undefined });
			expect(workspace.sandboxWritableRoots).toEqual(["/srv/app"]);
			const changed = await backend.api.updateWorkspace({ id: workspace.id, displayName: "test", remoteDefaultCwd: "/etc", expectedRevision: 1 });
			expect(changed.sandboxWritableRoots).toEqual(["/srv/app"]);
		} finally { await backend.close(); }
	});

	it("persists both levels after reopening a file database", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gori-roots-"));
		const path = join(directory, "state.sqlite");
		try {
			const backend = backendFor(path);
			const { workspace } = await backend.api.createWorkspace(input);
			const session = await backend.api.createSession({ workspaceId: workspace.id, displayName: "custom", sandboxWritableRoots: ["/etc/app", "/var/log/app"] });
			await backend.close();
			const reopened = backendFor(path);
			try {
				expect((await reopened.api.getSession(session.id)).sandboxWritableRoots).toEqual(["/etc/app", "/var/log/app"]);
				expect(await targetsFor(reopened.database).resolveWorkspace(workspace.id)).toMatchObject({ sandboxWritableRoots: roots });
			} finally { await reopened.close(); }
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	it.each([null, "/srv/app", [], ["/"], ["relative"], ["/bad\npath"], ["/bad\0path"], ["/srv/app", "/srv/app"], [42], Array.from({ length: 17 }, (_, i) => `/srv/${i}`)])(
		"rejects malformed scope through the HTTP boundary: %j", async (sandboxWritableRoots) => {
			const backend = backendFor();
			try {
				const { workspace } = await backend.api.createWorkspace(input);
				const session = await backend.api.createSession({ workspaceId: workspace.id, displayName: "test" });
				for (const path of [`/api/workspaces/${workspace.id}`, `/api/sessions/${session.id}`]) {
					const response = await backend.handleRequest(new Request(`http://localhost${path}`, { method: "PATCH", headers: { "content-type": "application/json" },
						body: JSON.stringify({ displayName: "test", sandboxWritableRoots, expectedRevision: 1 }) }));
					expect(response.status).toBe(400);
				}
				expect((await backend.api.getSession(session.id)).revision).toBe(1);
			} finally { await backend.close(); }
		},
	);

	it("keeps spaces and remote dot segments intact until realpath on the target machine", () => {
		const paths = ["/srv/link/../app", "/srv/app "];
		expect(requireSandboxWritableRoots(paths)).toEqual(paths);
		expect(readStoredSandboxWritableRoots(JSON.stringify(paths))).toEqual(paths);
	});

	it("migrates frozen v27 defaults into independent Session copies and preserves revisions and audit history", async () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec(readFileSync(new URL("./fixtures/schema-v27-sandbox.sql", import.meta.url), "utf8"));
			applyMigrations(database);
			const sessions = new SqliteSessionRepository(database);
			expect(await sessions.findById("s-app")).toMatchObject({ sandboxWritableRoots: ["/srv/link/../app "], revision: 4, sandboxEnabled: false });
			expect(await sessions.findById("s-root")).toMatchObject({ sandboxWritableRoots: [], revision: 2 });
			expect(database.prepare("SELECT revision, sandbox_writable_roots_json FROM workspaces WHERE id='w-app'").get()).toMatchObject({ revision: 7, sandbox_writable_roots_json: '["/srv/link/../app "]' });
			expect(database.prepare("SELECT sandbox_json FROM command_operations WHERE id='history'").get()?.sandbox_json).toBe('{"mode":"workspace_write","sandboxRoot":"/srv/app"}');
			database.exec("UPDATE workspaces SET sandbox_writable_roots_json='[\"/etc/app\"]' WHERE id='w-app'");
			applyMigrations(database);
			expect((await sessions.findById("s-app"))?.sandboxWritableRoots).toEqual(["/srv/link/../app "]);
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally { database.close(); }
	});
});

describe("complete scope in authorization and execution evidence", () => {
	const target = { workspaceId: "w", workspaceRevision: 1, hostname: "fixture.invalid", port: 22,
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:fixture", credentialId: "c", credentialAuthVersion: 1,
		remoteUser: "fixture", defaultCwd: "/srv/app", sandboxWritableRoots: roots,
		connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
	it("deeply snapshots writable directories in an execution plan", () => {
		const mutableTarget = { ...target, sandboxWritableRoots: [...roots] };
		const plan = new RemoteCommandExecutionPlan({ sessionId: "s", toolCallId: "t", request: { command: "true" }, access: { mode: "workspace_write" }, expectedTarget: mutableTarget });
		mutableTarget.sandboxWritableRoots.push("/etc");
		expect(plan.expectedTarget?.sandboxWritableRoots).toEqual(roots);
		expect(Object.isFrozen(plan.expectedTarget?.sandboxWritableRoots)).toBe(true);
	});
	it("invalidates an exception grant when a second writable directory changes", () => {
		const approvals = new RemoteSandboxApprovalStore();
		const request = { agentRunId: "run", sessionId: "s", toolCallId: "t", command: "true", justification: "test" };
		approvals.approve(request, target);
		expect(approvals.consume(request, { ...target, sandboxWritableRoots: [roots[0]] })).toBe(false);
		approvals.approve(request, target);
		expect(approvals.consume(request, { ...target, sandboxWritableRoots: [...roots] })).toBe(true);
	});
	it.each(["landlock", "bubblewrap"] as const)("reads all %s roots, retains historical evidence and rejects damaged lists", (backend) => {
		const metadata = backend === "landlock" ? { abi: 8, launcherVersion: "3" } : { bubblewrapVersion: "0.12.0" };
		const legacy = { mode: "workspace_write", backend, enforcement: "full", sandboxRoot: roots[0], ...metadata };
		const facts = { ...legacy, sandboxRoots: roots };
		const terminal = (value: object) => readStoredTerminalSandbox({ status: "active", requested_sandbox_mode: "workspace_write", sandbox_json: JSON.stringify(value) }).sandbox;
		expect(terminal(legacy)).toEqual(legacy);
		expect(terminal(facts)).toEqual(facts);
		expect(readStoredCommandSandbox(JSON.stringify({ ...facts, commandMayHaveRun: true }))).toEqual({ ...facts, commandMayHaveRun: true });
		for (const sandboxRoots of [[], [roots[0], "/"], [roots[1], roots[0]], [roots[0], roots[0]], [roots[0], "/srv/app/../other"]]) {
			expect(() => terminal({ ...facts, sandboxRoots })).toThrow();
			expect(() => readStoredCommandSandbox(JSON.stringify({ ...facts, sandboxRoots, commandMayHaveRun: true }))).toThrow();
		}
	});
});
