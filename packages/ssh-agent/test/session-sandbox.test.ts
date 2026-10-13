import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandOperationService } from "../src/application/services/command-operation-service.ts";
import { DefaultSessionService } from "../src/application/services/session-service.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import { sessionSandboxInstructions } from "../src/application/services/session-sandbox-policy.ts";
import { TerminalSessionService } from "../src/application/services/terminal-session-service.ts";
import type { ExecuteRemoteCommandInput, TerminalChannelHandle, TerminalChannelExit, OpenTerminalChannelInput } from "../src/application/ssh-channel-broker.ts";
import { wrapRemoteCommand } from "../src/application/remote-shell-command.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteWorkspaceRepository } from "../src/infrastructure/sqlite/sqlite-workspace-repository.ts";
import { SqliteCommandOperationRepository } from "../src/infrastructure/sqlite/sqlite-command-operation-repository.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";
import { terminalTestSandbox } from "./terminal-test-sandbox.ts";
import { parseCreateSession, parseUpdateSession } from "../src/api/request-validation.ts";

const target: SshTargetSnapshot = { workspaceId: "workspace", workspaceRevision: 1, credentialId: "credential",
	credentialAuthVersion: 1, hostname: "test.invalid", port: 22, remoteUser: "test", hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:test", defaultCwd: "/srv/app", connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

class TerminalHandle implements TerminalChannelHandle {
	readonly connectionGeneration = 1;
	readonly closed: Promise<TerminalChannelExit>;
	private resolveClosed!: (exit: TerminalChannelExit) => void;
	private disposed = false;
	constructor() { this.closed = new Promise((resolve) => { this.resolveClosed = resolve; }); }
	isClosed() { return this.disposed; }
	startOutput() {}
	async write() {}
	async resize() {}
	setReadPaused() {}
	async close() { this.dispose(); }
	dispose() { this.disposed = true; this.resolveClosed({ kind: "closed" }); }
}

function fixture(options: { commandSandbox?: boolean } = {}) {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	applyMigrations(database);
	database.exec(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
		connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
		VALUES ('workspace', 'test', 'development', 'test.invalid', 22, '/srv/app', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, revision, created_at, updated_at)
		VALUES ('session', 'workspace', 'test', 1, 1, 1), ('other', 'workspace', 'other', 1, 1, 1);`);
	database.exec(`INSERT INTO credentials (id, workspace_id, display_name, type, remote_user, is_active, auth_version, revision, created_at, updated_at)
		VALUES ('credential', 'workspace', 'test', 'password', 'test', 1, 1, 1, 1, 1);`);
	const sessions = new SqliteSessionRepository(database);
	const operations = new SqliteCommandOperationRepository(database);
	const terminals = new SqliteTerminalRepository(database);
	const lifecycle = new SessionLifecycleCoordinator();
	let nextId = 0;
	const ids = { next: () => `test-${++nextId}` };
	const clock = { now: () => Date.now() };
	const targets = { resolve: vi.fn(async (sessionId: string) => ({ ...target, sandboxWritableRoots: (await sessions.findById(sessionId))?.sandboxWritableRoots })) };
	const guards = { evaluate: vi.fn(async () => ({ allowed: true })) };
	const prepare = vi.fn(async (input: { cwd: string; command: string }) => ({ command: `confined:${wrapRemoteCommand(input.cwd, input.command)}`,
		confirmation: "test: confined", sandbox: { mode: "workspace_write" as const, backend: "landlock" as const,
			enforcement: "full" as const, abi: 8, launcherVersion: "3", sandboxRoot: target.defaultCwd } }));
	const prepareTerminal = vi.fn(terminalTestSandbox.prepareTerminal);
	const sandbox = { prepare, prepareTerminal };
	const execute = vi.fn(async (input: ExecuteRemoteCommandInput) => {
		if (input.command.startsWith("confined:")) await input.onStderr(new TextEncoder().encode("test: confined\n"));
		return { exitCode: 0 };
	});
	const open = vi.fn(async (_input: OpenTerminalChannelInput) => new TerminalHandle());
	const commandService = new CommandOperationService({ operations, sessions, targets, guards, broker: { execute },
		sandbox: options.commandSandbox === false ? undefined : sandbox, lifecycle, ids, clock });
	const terminalService = new TerminalSessionService({ sessions, terminals, targets, broker: { open }, sandbox, lifecycle, ids, clock,
		hasActiveChatRun: async () => false, openTimeoutMs: 500 });
	const sessionService = new DefaultSessionService({ sessions, workspaces: new SqliteWorkspaceRepository(database), lifecycle, operations, ids, clock,
		reconfigureTerminal: (id, persist) => terminalService.reconfigureSandbox(id, persist) });
	cleanups.push(async () => { await terminalService.shutdown(); await commandService.close(); database.close(); });
	const change = async (sandboxEnabled: boolean) => sessionService.update({ id: "session", expectedRevision: (await sessionService.get("session")).revision, sandboxEnabled });
	return { database, sessions, operations, lifecycle, targets, guards, prepare, prepareTerminal, execute, open, commandService, terminalService, sessionService, change };
}

const command = { sessionId: "session", toolCallId: "call", command: "echo ok" };
async function activeTerminal(f: ReturnType<typeof fixture>) {
	await vi.waitFor(() => expect(f.terminalService.get("session")?.status).toBe("active"));
	return f.terminalService.get("session")!;
}

describe("Session sandbox execution policy", () => {
	it("accepts only boolean Session sandbox settings at the API boundary", () => {
		expect(parseCreateSession({ displayName: "new", sandboxEnabled: false })).toMatchObject({ sandboxEnabled: false });
		expect(parseUpdateSession({ expectedRevision: 1, sandboxEnabled: true })).toMatchObject({ sandboxEnabled: true });
		for (const sandboxEnabled of ["false", 0, null]) {
			expect(() => parseUpdateSession({ expectedRevision: 1, sandboxEnabled })).toThrow();
		}
	});
	it("defaults existing and new Sessions to enabled, and scopes changes to one Session", async () => {
		const f = fixture();
		expect((await f.sessionService.get("session")).sandboxEnabled).toBe(true);
		const created = await f.sessionService.create({ workspaceId: "workspace", displayName: "new", workDir: "/tmp" });
		expect(created.sandboxEnabled).toBe(true);
		await f.change(false);
		expect((await f.sessionService.get("session")).sandboxEnabled).toBe(false);
		expect((await f.sessionService.get("other")).sandboxEnabled).toBe(true);
	});

	it("migrates v26 Sessions to enabled without changing their revisions or other settings", async () => {
		const f = fixture();
		f.database.exec("ALTER TABLE sessions DROP COLUMN sandbox_enabled; DELETE FROM ssh_agent_schema_migrations WHERE version = 27");
		applyMigrations(f.database);
		expect(await f.sessions.findById("session")).toMatchObject({ sandboxEnabled: true, autoAudit: false, revision: 1 });
		applyMigrations(f.database);
		expect(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toMatchObject({ count: 2 });
	});

	it("bypasses command preparation and grants, and restores confinement when enabled", async () => {
		const f = fixture(); await f.change(false);
		const direct = await f.commandService.submit({ ...command, cwd: "/etc", sandboxPermissions: "full_access" });
		expect(direct.operation.status).toBe("completed");
		expect(f.execute.mock.calls[0]?.[0].command).toBe(wrapRemoteCommand("/etc", command.command));
		expect(f.prepare).not.toHaveBeenCalled();
		expect(await f.operations.findById(direct.operation.id)).toMatchObject({ sandbox: {
			mode: "full_access", backend: "none", enforcement: "none", authorizationSource: "session_setting" } });
		await f.change(true);
		const confined = await f.commandService.submit({ ...command, toolCallId: "enabled" });
		expect(confined.operation).toMatchObject({ status: "completed", sandbox: { mode: "workspace_write", enforcement: "full" } });
		expect(f.prepare).toHaveBeenCalledOnce();
		await expect(f.commandService.submit({ ...command, sandboxPermissions: "full_access" })).rejects.toMatchObject({ failure: { code: "invalid_request" } });
	});

	it("rejects command authorization when only the writable directory list changes", async () => {
		const f = fixture();
		await f.sessionService.update({ id: "session", sandboxWritableRoots: ["/srv/app", "/var/log/app"], expectedRevision: 1 });
		const result = await f.commandService.submit({ ...command, expectedTarget: { ...target, sandboxWritableRoots: ["/srv/app"] } });
		expect(result.operation.failure?.code).toBe("invalid_request");
		expect(f.prepare).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
	});

	it.each(["chat_run", "command_operation", "deployment_run", "terminal_open"] as const)("blocks directory changes during %s", async (kind) => {
		const f = fixture(); const lease = f.lifecycle.acquireUse("session", kind);
		await expect(f.sessionService.update({ id: "session", sandboxWritableRoots: ["/srv/app", "/etc/app"], expectedRevision: 1 }))
			.rejects.toMatchObject({ code: kind === "chat_run" ? "session_has_active_chat_run" : "session_has_active_operations" });
		lease.release();
	});

	it("still blocks Guard denials, invalid cwd and changed SSH targets when disabled", async () => {
		const f = fixture(); await f.change(false);
		f.guards.evaluate.mockResolvedValueOnce({ allowed: false });
		expect((await f.commandService.submit(command)).operation.failure?.code).toBe("guard_blocked");
		expect((await f.commandService.submit({ ...command, toolCallId: "cwd", cwd: "relative" })).operation.failure?.code).toBe("invalid_request");
		expect((await f.commandService.submit({ ...command, toolCallId: "target", expectedTarget: { ...target, credentialAuthVersion: 2 } })).operation.failure?.code).toBe("invalid_request");
		expect(f.execute).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
	});

	it("runs without a sandbox provider only when the Session explicitly disables it", async () => {
		const f = fixture({ commandSandbox: false });
		expect((await f.commandService.submit(command)).operation.failure?.code).toBe("sandbox_unavailable");
		expect(f.execute).not.toHaveBeenCalled();
		await f.change(false);
		expect((await f.commandService.submit({ ...command, toolCallId: "disabled" })).operation.status).toBe("completed");
		expect(f.execute).toHaveBeenCalledOnce();
	});

	it.each([true, false])("refuses stale authorization when the current setting is %s", async (enabled) => {
		const f = fixture(); await f.change(enabled);
		await expect(f.commandService.submit({ ...command, expectedSandboxEnabled: !enabled })).rejects.toMatchObject({ failure: { code: "sandbox_approval_required" } });
		expect(f.execute).not.toHaveBeenCalled(); expect(await f.operations.countActiveBySessionId("session")).toBe(0);
	});

	it.each(["chat_run", "chat_compaction", "command_operation", "deployment_run", "terminal_open"] as const)("refuses switching during %s", async (kind) => {
		const f = fixture(); const lease = f.lifecycle.acquireUse("session", kind);
		await expect(f.change(false)).rejects.toMatchObject({ code: kind === "chat_run" ? "session_has_active_chat_run" : "session_has_active_operations" });
		expect((await f.sessions.findById("session"))?.sandboxEnabled).toBe(true);
		lease.release(); expect((await f.change(false)).sandboxEnabled).toBe(false);
	});

	it("keeps Guard and ordinary approval in the trusted current prompt instruction", () => {
		expect(sessionSandboxInstructions("full_access")).toContain("disabled remote sandboxing for this Session");
		expect(sessionSandboxInstructions("full_access")).toContain("ordinary command approval");
	});
});

describe("Session sandbox Terminal reconfiguration", () => {
	it("replaces a live PTY in both directions with the same geometry and actual mode facts", async () => {
		const f = fixture(); await f.terminalService.open({ sessionId: "session", requestId: "first", rows: 40, cols: 100 });
		const first = await activeTerminal(f); expect(f.prepareTerminal).toHaveBeenCalledOnce();
		await f.change(false); const direct = await activeTerminal(f);
		expect(first.id).not.toBe(direct.id); expect(direct.geometry).toEqual({ rows: 40, cols: 100 });
		expect(direct).toMatchObject({ requestedSandboxMode: "full_access", sandbox: { mode: "full_access", source: "session_setting" } });
		expect(f.prepareTerminal).toHaveBeenCalledOnce();
		const launch = f.open.mock.calls[1]?.[0].launch;
		expect(launch).toMatchObject({ kind: "unconfined_exec", confirmation: expect.stringMatching(/^gori-terminal: ready token=/) });
		if (!launch || launch.kind === "login_shell") throw new Error("Missing exec launch");
		expect(launch.command).not.toMatch(/landlock|bubblewrap|test-launcher/);
		await f.change(true); const confined = await activeTerminal(f);
		expect(confined).toMatchObject({ requestedSandboxMode: "workspace_write", sandbox: { enforcement: "full" }, geometry: first.geometry });
		expect(f.prepareTerminal).toHaveBeenCalledTimes(2); expect(f.open).toHaveBeenCalledTimes(3);
	});

	it("automatically replaces a confined PTY when writable directories change, preserving geometry and other Sessions", async () => {
		const f = fixture();
		await f.terminalService.open({ sessionId: "session", requestId: "first", rows: 40, cols: 100 });
		const first = await activeTerminal(f);
		const roots = ["/srv/app", "/var/log/app"];
		await f.sessionService.update({ id: "session", sandboxWritableRoots: roots, expectedRevision: 1 });
		const reopened = await activeTerminal(f);
		expect(reopened.id).not.toBe(first.id);
		expect(reopened.geometry).toEqual(first.geometry);
		expect(f.prepareTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ sandboxWritableRoots: roots }) }));
		expect((await f.sessions.findById("other"))?.sandboxWritableRoots).toBeUndefined();
		await f.sessionService.update({ id: "session", sandboxWritableRoots: roots, expectedRevision: 2 });
		expect(f.open).toHaveBeenCalledTimes(2);
	});

	it("validates the whole list before closing a live PTY and keeps new settings when reopen fails", async () => {
		const f = fixture();
		await f.terminalService.open({ sessionId: "session", requestId: "first" });
		const first = await activeTerminal(f);
		await expect(f.sessionService.update({ id: "session", sandboxWritableRoots: ["/srv/app", "/"], expectedRevision: 1 }))
			.rejects.toMatchObject({ code: "validation_error" });
		expect(f.terminalService.get("session")?.id).toBe(first.id);
		expect(f.terminalService.get("session")?.status).toBe("active");
		f.prepareTerminal.mockRejectedValueOnce(new Error("second writable directory missing"));
		await f.sessionService.update({ id: "session", sandboxWritableRoots: ["/srv/app", "/missing"], expectedRevision: 1 });
		await vi.waitFor(() => expect(f.terminalService.get("session")?.status).toBe("failed"));
		expect((await f.sessions.findById("session"))?.sandboxWritableRoots).toEqual(["/srv/app", "/missing"]);
		expect(f.open).toHaveBeenCalledOnce();
	});

	it("does not restart an unconfined PTY for a future confined directory setting", async () => {
		const f = fixture(); await f.change(false);
		await f.terminalService.open({ sessionId: "session", requestId: "first" });
		const first = await activeTerminal(f);
		await f.sessionService.update({ id: "session", sandboxWritableRoots: ["/srv/app", "/etc/app"], expectedRevision: 2 });
		expect(f.terminalService.get("session")?.id).toBe(first.id);
		expect(f.prepareTerminal).not.toHaveBeenCalled();
	});

	it("does not open Terminal unless already active; a later open uses the current policy", async () => {
		const f = fixture(); await f.change(false); expect(f.open).not.toHaveBeenCalled();
		await f.terminalService.open({ sessionId: "session", requestId: "direct" }); await activeTerminal(f);
		expect(f.prepareTerminal).not.toHaveBeenCalled();
	});

	it("holds the configuration gate while closing, persisting and reopening", async () => {
		const f = fixture(); await f.terminalService.open({ sessionId: "session", requestId: "first" }); await activeTerminal(f);
		let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
		const original = f.sessions.update.bind(f.sessions);
		vi.spyOn(f.sessions, "update").mockImplementation(async (...args) => { await gate; return original(...args); });
		const switching = f.change(false);
		await vi.waitFor(() => expect(f.terminalService.get("session")?.status).toBe("closed"));
		await expect(f.commandService.submit(command)).rejects.toMatchObject({ code: "session_configuration_in_progress" });
		await expect(f.terminalService.open({ sessionId: "session", requestId: "competing" })).rejects.toMatchObject({ code: "session_configuration_in_progress" });
		expect(() => f.lifecycle.acquireUse("session", "chat_run")).toThrowError(expect.objectContaining({ code: "session_configuration_in_progress" }));
		release(); await switching; await activeTerminal(f);
		expect(f.lifecycle.getUsage("session").byKind.sandbox_update).toBe(0);
	});

	it("restores the prior Terminal policy if persistence fails", async () => {
		const f = fixture(); await f.terminalService.open({ sessionId: "session", requestId: "first" }); await activeTerminal(f);
		vi.spyOn(f.sessions, "update").mockResolvedValueOnce(false);
		await expect(f.change(false)).rejects.toMatchObject({ code: "revision_conflict" });
		expect((await activeTerminal(f)).requestedSandboxMode).toBe("workspace_write");
		expect((await f.sessions.findById("session"))?.sandboxEnabled).toBe(true);
	});

	it("keeps the enabled setting and records reopening failure if no sandbox can start", async () => {
		const f = fixture(); await f.change(false); await f.terminalService.open({ sessionId: "session", requestId: "first" }); await activeTerminal(f);
		f.prepareTerminal.mockRejectedValueOnce(new Error("sandbox unavailable")); await f.change(true);
		await vi.waitFor(() => expect(f.terminalService.get("session")?.status).toBe("failed"));
		expect((await f.sessions.findById("session"))?.sandboxEnabled).toBe(true); expect(f.open).toHaveBeenCalledOnce();
	});

	it("retains the setting error if restoring the previous Terminal also fails", async () => {
		const f = fixture(); await f.terminalService.open({ sessionId: "session", requestId: "first" }); await activeTerminal(f);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			vi.spyOn(f.sessions, "update").mockImplementationOnce(async () => { await f.terminalService.shutdown(); return false; });
			await expect(f.change(false)).rejects.toMatchObject({ code: "revision_conflict" });
			expect((await f.sessions.findById("session"))?.sandboxEnabled).toBe(true);
			expect(log).toHaveBeenCalledWith("Failed to restore Terminal after Session configuration failure", expect.objectContaining({ sessionId: "session" }));
		} finally { log.mockRestore(); }
	});
});
