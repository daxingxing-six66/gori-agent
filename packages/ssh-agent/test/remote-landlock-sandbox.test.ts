import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatToolAuthorizationPolicy } from "../src/application/services/chat-tool-authorization-policy.ts";
import { ChatToolCallCoordinator } from "../src/application/services/chat-tool-call-coordinator.ts";
import { CommandOperationService } from "../src/application/services/command-operation-service.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import { createRemoteServerCallTool } from "../src/application/tools/remote-server-call-tool.ts";
import type { RemoteSandboxProvider } from "../src/application/services/remote-sandbox-provider.ts";
import type { ExecuteRemoteCommandInput, UploadRemoteFileInput } from "../src/application/ssh-channel-broker.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import { sandboxFailure } from "../src/domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { LandlockRemoteSandboxProvider } from "../src/infrastructure/sandbox/landlock-remote-sandbox-provider.ts";
import { shellArgv, wrapRemoteCommand } from "../src/infrastructure/sandbox/shell-command.ts";
import { openSshAgentDatabase } from "../src/infrastructure/sqlite/database.ts";
import { SqliteCommandOperationRepository } from "../src/infrastructure/sqlite/sqlite-command-operation-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";

const target: SshTargetSnapshot = { workspaceId: "w", workspaceRevision: 1, hostname: "example.test", port: 22,
 hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:test", credentialId: "c", credentialAuthVersion: 1,
 remoteUser: "test", defaultCwd: "/opt/app", connectTimeoutMs: 1000,
 keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
const binary = Buffer.from("test launcher binary");
const hash = createHash("sha256").update(binary).digest("hex");
class RemoteHost {
 readonly commands: string[] = [];
 readonly uploads: string[] = [];
 generation = 1;
 platform = "Linux\nx86_64\n/home/test\n";
 abi = 5;
 existingHash = "missing";
 root = "/opt/app\n";
 rootFailure = false;
 uploadFailure = false;
 probeFailure = false;
 unavailable = false;
 splitUtf8 = false;
 temporaryRoot = "/tmp\n";
 nullFailure = false;
 async execute(input: ExecuteRemoteCommandInput) {
  this.commands.push(input.command);
  let output = "";
  if (input.command === "test -d /tmp && realpath -e -- /tmp") output = this.temporaryRoot;
  else if (input.command.startsWith("test -c /dev/null") && this.nullFailure) return { exitCode: 1 };
  else if (input.command.includes("realpath -e")) {
   if (this.rootFailure) return { exitCode: 1 };
   output = this.root;
  } else if (input.command.startsWith("uname")) output = this.platform;
  else if (input.command.includes("pwd -P")) output = `/home/test/.cache/gori/sandbox/1/${hash}\n`;
  else if (input.command.startsWith("sha256sum")) output = `${this.existingHash}  gori-landlock-run\n`;
  else if (input.command.includes("'--probe'")) {
   if (this.probeFailure) return { exitCode: 125 };
   output = this.unavailable ? "gori-landlock: unavailable\n" : `gori-landlock: abi=${this.abi} enforcement=${this.abi >= 5 ? "full" : "partial"}\n`;
  }
  if (output) {
   const buffer = Buffer.from(output);
   if (this.splitUtf8) for (const byte of buffer) await input.onStdout(Uint8Array.of(byte));
   else await input.onStdout(buffer);
  }
  return { exitCode: 0 };
 }
 async upload(input: UploadRemoteFileInput) {
  if (this.uploadFailure) throw new Error("SFTP unavailable");
  this.uploads.push(input.remotePath);
  const chunks: Uint8Array[] = [];
  for await (const chunk of input.data) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(binary);
  this.existingHash = hash;
  return { bytesTransferred: binary.length };
 }
 async deleteFile() {}
 snapshotWorkspace() { return { workspaceId: "w", state: "connected" as const, generation: this.generation, activeChannels: 0, waitingChannels: 0 }; }
}
function providerFixture() {
 const host = new RemoteHost();
 const loadBinary = vi.fn(async () => binary);
 const provider = new LandlockRemoteSandboxProvider({ broker: host, loadBinary });
 const prepare = (root = "/opt/app") => provider.prepare({ target: { ...target, defaultCwd: root }, cwd: "/opt/app/current",
  command: "python -c 'print(1)'", signal: new AbortController().signal });
 return { host, provider, loadBinary, prepare };
}
describe("Remote launcher distribution and capability", () => {
	it("reuses backend discovery for ordinary queries but checks the current root and devices each time", async () => {
		const f = providerFixture();
		const signal = new AbortController().signal;
		await f.provider.getCapabilities(target, signal);
		await f.provider.getCapabilities(target, signal);
		expect(f.host.commands.filter((command) => command.includes("'--probe'"))).toHaveLength(1);
		expect(f.host.commands.filter((command) => command.startsWith("test -d '/opt/app'"))).toHaveLength(2);
		f.host.nullFailure = true;
		await expect(f.provider.getCapabilities(target, signal)).rejects.toMatchObject({ failure: {
			code: "sandbox_prepare_failed", safeDetails: { sandboxStage: "null device", commandMayHaveRun: false },
		} });
		expect(f.host.commands.filter((command) => command.includes("'--probe'"))).toHaveLength(1);
	});

	it("merges explicit refreshes while retaining per-request policy validation", async () => {
		const f = providerFixture();
		await f.prepare();
		const signal = new AbortController().signal;
		await Promise.all([f.provider.refreshCapabilities(target, signal), f.provider.refreshCapabilities(target, signal)]);
		expect(f.host.commands.filter((command) => command.includes("'--probe'"))).toHaveLength(2);
		expect(f.loadBinary).toHaveBeenCalledTimes(2);
		expect(f.host.commands.filter((command) => command.startsWith("test -d '/opt/app'"))).toHaveLength(3);
	});

	it("reports root validation stderr and the remote exit status", async () => {
		const f = providerFixture();
		vi.spyOn(f.host, "execute").mockImplementationOnce(async (input) => {
			await input.onStderr(Buffer.from("realpath: /opt/app: Permission denied\n"));
			return { exitCode: 1 };
		});
		await expect(f.prepare()).rejects.toMatchObject({ failure: { code: "sandbox_root_unavailable",
			message: expect.stringContaining("realpath: /opt/app: Permission denied"),
			safeDetails: { sandboxStage: "writable root", exitCode: 1, commandMayHaveRun: false },
		} });
		expect(f.host.uploads).toEqual([]);
	});

	it("prepares a nonce-bound interactive shell using the canonical root and no Bash override", async () => {
		const f = providerFixture();
		const prepared = await f.provider.prepareTerminal({ target, signal: new AbortController().signal });
		expect(prepared.sandbox).toMatchObject({ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app" });
		expect(prepared.command).toContain("'--ro' '/' '--rw' '/dev/null' '--rw' '/tmp' '--rw' '/opt/app'");
		expect(prepared.command).toMatch(/^cd -- '\/opt\/app' && exec /);
		expect(prepared.command).toContain("'--' '--terminal'");
		expect(prepared.command).not.toContain("/bin/bash");
		const token = /token=([0-9a-f]{32})$/.exec(prepared.confirmation)?.[1];
		expect(token).toBeDefined();
		expect(prepared.command).toContain(`'--confirm-token' '${token}'`);
		const next = await f.provider.prepareTerminal({ target, signal: new AbortController().signal });
		expect(next.confirmation).not.toBe(prepared.confirmation);
	});
 it("does not run later script statements after a failed cwd change", () => {
  const directory = mkdtempSync(join(tmpdir(), "gori-cwd-test-"));
  try {
   const marker = join(directory, "must-not-exist");
   const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", wrapRemoteCommand(join(directory, "missing"), `echo first; ${shellArgv(["touch", marker])}`)]);
   expect(result.status).not.toBe(0); expect(existsSync(marker)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
 });
 it("uploads once, atomically installs, probes and reuses per connection identity", async () => {
  const f = providerFixture();
  const result = await f.prepare();
  expect(result).toMatchObject({ sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, sandboxRoot: "/opt/app" } });
  const token = /token=([0-9a-f]{32})\n$/.exec(result.confirmation)?.[1];
  expect(token).toBeDefined();
  expect(result.command).toContain(`'--confirm-token' '${token}'`);
  expect(result.command).toContain("'--ro' '/' '--rw' '/dev/null' '--rw' '/tmp' '--rw' '/opt/app'");
  expect(result.command).toContain("'--' '/bin/bash' '--noprofile' '--norc' '-c'");
  expect(f.host.uploads).toHaveLength(1);
  expect(f.host.commands.some((c) => c.includes("chmod 0700") && c.includes("mv -fT"))).toBe(true);
  await f.prepare();
  expect(f.loadBinary).toHaveBeenCalledOnce();
  expect(f.host.commands.filter((c) => c.includes("'--probe'"))).toHaveLength(1);
  f.host.generation++;
  await f.prepare();
  expect(f.host.uploads).toHaveLength(1);
  expect(f.host.commands.filter((c) => c.includes("'--probe'"))).toHaveLength(2);
 });
 it("does not widen the writable root when a command overrides cwd", async () => {
  const f = providerFixture();
  const prepared = await f.provider.prepare({ target, cwd: "/etc", command: "touch example", signal: new AbortController().signal });
  expect(prepared.sandbox.sandboxRoot).toBe("/opt/app");
  expect(prepared.command).toContain(shellArgv(["--rw", "/opt/app"]));
  expect(prepared.command).toContain(shellArgv(["-c", wrapRemoteCommand("/etc", "touch example")]));
  expect(prepared.command).not.toContain(shellArgv(["--rw", "/etc"]));
 });
 it("coalesces concurrent deployment and canonicalizes each root", async () => {
  const f = providerFixture();
  await Promise.all([f.prepare(), f.prepare()]);
  expect(f.host.uploads).toHaveLength(1);
  expect(f.host.commands.filter((c) => c.includes("realpath -e") && c !== "test -d /tmp && realpath -e -- /tmp")).toHaveLength(2);
 });
 it("refreshes the capability for a new credential identity and an explicit probe", async () => {
  const f = providerFixture(); await f.prepare();
  await f.provider.prepare({ target: { ...target, credentialAuthVersion: 2 }, cwd: "/", command: "true", signal: new AbortController().signal });
  expect(f.host.commands.filter((c) => c.includes("'--probe'"))).toHaveLength(2);
  await f.provider.refreshCapabilities(target, new AbortController().signal);
  expect(f.host.commands.filter((c) => c.includes("'--probe'"))).toHaveLength(3);
  expect(f.host.commands.some((c) => c.includes("'--ro'"))).toBe(false);
 });
	it("runs an explicit probe after a concurrent preparation completes", async () => {
		const f = providerFixture();
		const original = f.host.execute.bind(f.host);
		let markStarted!: () => void;
		let releaseProbe!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const release = new Promise<void>((resolve) => { releaseProbe = resolve; });
		let pauseFirstProbe = true;
		vi.spyOn(f.host, "execute").mockImplementation(async (input) => {
			if (input.command.includes("'--probe'") && pauseFirstProbe) {
				pauseFirstProbe = false;
				markStarted();
				await release;
			}
			return original(input);
		});
		const preparation = f.prepare();
		await started;
		const refresh = f.provider.refreshCapabilities(target, new AbortController().signal);
		releaseProbe();
		await Promise.all([preparation, refresh]);
		expect(f.host.commands.filter((command) => command.includes("'--probe'"))).toHaveLength(2);
	});
	it("fails closed if /tmp aliases another directory or /dev/null is not the null device", async () => {
  const f = providerFixture(); f.host.temporaryRoot = "/\n";
  await expect(f.prepare()).rejects.toMatchObject({ failure: { code: "sandbox_prepare_failed" } });
	 f.host.temporaryRoot = "/etc\n";
	 await expect(f.prepare()).rejects.toMatchObject({ failure: { code: "sandbox_prepare_failed" } });
  f.host.temporaryRoot = "/tmp\n"; f.host.nullFailure = true;
  await expect(f.prepare()).rejects.toMatchObject({ failure: { code: "sandbox_prepare_failed" } });
 });
	it("recognizes a kernel-disabled Landlock probe before requiring a writable root", async () => {
		const f = providerFixture();
		f.host.unavailable = true;
		await expect(f.provider.prepareTerminal({ target: { ...target, defaultCwd: "/" }, signal: new AbortController().signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_unavailable" } });
		expect(f.host.commands.some((command) => command.includes("realpath -e"))).toBe(false);
	});
 it.each(["", "/", "/opt/..", "relative", "~", "/opt/\0app"])("rejects invalid root %s before SSH", async (root) => {
  const f = providerFixture();
  await expect(f.prepare(root)).rejects.toMatchObject({ failure: { code: "sandbox_root_invalid", safeDetails: { commandMayHaveRun: false } } });
  expect(f.host.commands).toEqual([]);
 });
 it("rejects root aliases to / and writable launcher cache", async () => {
  const f = providerFixture(); f.host.root = "/\n";
  await expect(f.prepare()).rejects.toMatchObject({ failure: { code: "sandbox_root_invalid" } });
  f.host.root = "/home/test\n";
  await expect(f.prepare()).rejects.toMatchObject({ failure: { code: "sandbox_root_invalid" } });
 });
 it.each([
  ["platform", "Darwin\narm64\n/home/test\n", "sandbox_unsupported_platform"],
  ["platform", "Linux\nriscv64\n/home/test\n", "sandbox_unsupported_architecture"],
  ["abi", 3, "sandbox_partial_enforcement"], ["probeFailure", true, "sandbox_probe_failed"],
  ["uploadFailure", true, "sandbox_launcher_upload_failed"], ["rootFailure", true, "sandbox_root_unavailable"],
 ] as const)("fails closed on %s", async (property, value, code) => {
  const f = providerFixture(); Object.assign(f.host, { [property]: value });
  await expect(f.prepare()).rejects.toMatchObject({ failure: { code, safeDetails: { commandMayHaveRun: false } } });
  expect(f.host.commands.every((c) => !c.includes("'--ro'"))).toBe(true);
 });
 it("rejects missing bundled launcher and selects arm64", async () => {
  const f = providerFixture(); f.loadBinary.mockRejectedValueOnce(new Error("ENOENT"));
  await expect(f.prepare()).rejects.toMatchObject({ failure: { code: "sandbox_launcher_missing" } });
  f.host.platform = "Linux\naarch64\n/home/test\n";
  await f.prepare(); expect(f.loadBinary).toHaveBeenLastCalledWith("arm64");
 });
 it("uses shell argument quoting for hostile paths and commands", async () => {
  const f = providerFixture(); f.host.root = "/opt/app ' $()\n";
  const result = await f.prepare("/opt/app ' $()");
  expect(result.command).toContain(shellArgv(["--rw", "/opt/app ' $()"]));
  expect(result.command).toContain(shellArgv(["-c", wrapRemoteCommand("/opt/app/current", "python -c 'print(1)'")]));
 });
 it("preserves canonical Unicode and trailing spaces across SSH byte chunks", async () => {
  const f = providerFixture(); f.host.root = "/opt/应用 \n"; f.host.splitUtf8 = true;
  const result = await f.prepare("/opt/应用 ");
  expect(result.sandbox.sandboxRoot).toBe("/opt/应用 ");
  expect(result.command).toContain(shellArgv(["--rw", "/opt/应用 "]));
 });
});
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
function operationFixture(options: { sandbox?: RemoteSandboxProvider; noProvider?: boolean; databasePath?: string;
 remoteRoute?: "unavailable" | "outside" } = {}) {
 const db = openSshAgentDatabase(options.databasePath ?? ":memory:");
 db.exec(`INSERT INTO workspaces (id,display_name,environment,hostname,port,default_cwd,remote_default_cwd,connect_timeout_ms,keepalive_interval_ms,keepalive_max_count,revision,created_at,updated_at) VALUES ('w','test','development','example.test',22,'/','/opt/app',1000,1000,3,1,1,1);
 INSERT INTO credentials (id,workspace_id,display_name,type,remote_user,is_active,auth_version,revision,created_at,updated_at) VALUES ('c','w','test','password','test',1,1,1,1,1);
 INSERT INTO sessions (id,workspace_id,display_name,revision,created_at,updated_at,auto_audit) VALUES ('s','w','test',1,1,1,1);`);
 const sessions = new SqliteSessionRepository(db);
 const repository = new SqliteCommandOperationRepository(db);
 const approvals = new RemoteSandboxApprovalStore();
 let blocked = false;
 const guards = { evaluate: vi.fn(async () => ({ allowed: !blocked, guardRevision: blocked ? 2 : 1 })) };
 const broker = { execute: vi.fn(async (input: ExecuteRemoteCommandInput) => {
  if (input.command.startsWith("confined ")) {
   await input.onStderr(Buffer.from("gori-landlock: conf"));
   await input.onStderr(Buffer.from("ined abi=5\n"));
  }
  return { exitCode: 0 };
 }) };
 const sandbox: RemoteSandboxProvider = options.sandbox ?? { prepareTerminal: async () => { throw new Error("Unexpected Terminal preparation"); }, prepare: vi.fn<RemoteSandboxProvider["prepare"]>(async ({ command, policy, target }) => ({
  command: policy.mode === "full_access" ? `unconfined ${command}` : `confined ${command}`,
  sandbox: policy.mode === "full_access"
   ? { mode: "full_access", backend: "none", enforcement: "none" }
   : { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: target.defaultCwd },
  confirmation: policy.mode === "full_access" ? undefined : "gori-landlock: confined abi=5\n",
 })) };
 let id = 0;
 let executionTarget = target;
 const service = new CommandOperationService({ operations: repository, sessions, targets: { resolve: async () => executionTarget },
  guards, broker, sandbox: options.noProvider ? undefined : sandbox, sandboxApprovals: approvals, clock: { now: Date.now }, ids: { next: () => `o-${++id}` } });
 let closed = false;
 const dispose = () => { if (!closed) { closed = true; service.close(); db.close(); } };
 disposers.push(dispose);
 const run: ChatRun = { id: "run", sessionId: "s", workspaceId: "w", requestId: "req", providerId: "p", modelId: "m", thinkingLevel: "off", serverInteractionMode: "command", terminalSessionId: null, status: "running", createdAt: 1, updatedAt: 1 };
 const policy = new ChatToolAuthorizationPolicy({ sessions, sandboxApprovals: approvals,
  terminalInteractions: { preflightSubmit: vi.fn(), approve: vi.fn(), reject: vi.fn() },
  ...(options.remoteRoute === undefined ? {} : { assessRemoteSandbox: async () => ({ target,
   route: { mode: "full_access" as const,
    reason: options.remoteRoute === "outside" ? "write_path_outside_sandbox" as const : "sandbox_unavailable" as const,
    details: options.remoteRoute === "outside" ? "Declared path /etc/app is outside the writable roots" : "No backend" } }) }),
  preflightRemoteGuard: async () => ({ allowed: !blocked }) });
 return { db, broker, guards, service, sandbox, approvals, repository, policy, run, dispose, block: () => { blocked = true; },
  changeTarget: (changed: SshTargetSnapshot) => { executionTarget = changed; } };
}
const request = { agentRunId: "run", toolCallId: "tool", sessionId: "s", command: "write outside", justification: "Update nginx config" };
const fullInput = { ...request, sandboxPermissions: "full_access" as const };
describe("Command execution and one-shot authorization", () => {
	it.each([undefined, "outside"] as const)("checks the plan's target again before dispatch (route=%s)", async (remoteRoute) => {
		const f = operationFixture({ remoteRoute });
		const authorization = new ChatToolAuthorizationPolicy({
			sessions: new SqliteSessionRepository(f.db), sandboxApprovals: f.approvals,
			terminalInteractions: { preflightSubmit: vi.fn(), approve: vi.fn(), reject: vi.fn() },
			preflightRemoteGuard: async () => ({ allowed: true }),
			assessRemoteSandbox: async () => ({ target, route: remoteRoute === "outside"
				? { mode: "full_access", reason: "write_path_outside_sandbox", details: "Outside writable roots" }
				: { mode: "workspace_write", facts: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, sandboxRoot: target.defaultCwd } } }),
		});
		const coordinator = new ChatToolCallCoordinator({ authorization,
			approvals: { request: async () => ({ approved: true, source: "user" }) } });
		const args = { command: "write config" };
		const approved = await coordinator.beforeToolCall({ run: f.run, toolCallId: "tool", toolName: "remote_server_call",
			assistantMessageId: "message", args, onApprovalRejection: vi.fn() });
		f.changeTarget({ ...target, defaultCwd: "/other/app", workspaceRevision: 2 });
		const tool = createRemoteServerCallTool({ sessionId: "s", agentRunId: "run", operations: f.service });
		await expect(tool.execute("tool", args, undefined, undefined, approved?.executionContext)).rejects.toMatchObject({
			details: { failure: { code: remoteRoute === "outside" ? "sandbox_approval_required" : "invalid_request" } },
		});
		expect(f.broker.execute).not.toHaveBeenCalled();
	});

 it("restores actual sandbox facts and full-access justification after reopening a file database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gori-sandbox-audit-"));
  try {
   const path = join(directory, "audit.sqlite"); const f = operationFixture({ databasePath: path });
   const confined = await f.service.submit({ agentRunId: "run", toolCallId: "t", sessionId: "s", command: "echo x" });
   f.approvals.approve(request); const full = await f.service.submit(fullInput); f.dispose();
   const db = openSshAgentDatabase(path);
   try {
    const repository = new SqliteCommandOperationRepository(db);
    expect(await repository.findById(confined.operation.id)).toMatchObject({ agentRunId: "run", sandbox: confined.operation.sandbox });
    expect(await repository.findById(full.operation.id)).toMatchObject({ sandbox: { mode: "full_access", enforcement: "none" }, sandboxJustification: request.justification });
   } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
 });
	it.each([
		["JSON null", "null"],
		["none claiming full enforcement", JSON.stringify({ mode: "workspace_write", backend: "none", enforcement: "full" })],
		["noninteger ABI", JSON.stringify({ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: "8" })],
		["Full Access claiming Landlock", JSON.stringify({ mode: "full_access", backend: "landlock", enforcement: "full" })],
		["nonboolean execution fact", JSON.stringify({ mode: "workspace_write", backend: "landlock", enforcement: "full", commandMayHaveRun: "yes" })],
		...([
			["missing ABI", { mode: "workspace_write", backend: "landlock", enforcement: "full", launcherVersion: "3", sandboxRoot: "/opt/app", commandMayHaveRun: true }],
			["missing launcher version", { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, sandboxRoot: "/opt/app", commandMayHaveRun: true }],
			["missing sandbox root", { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", commandMayHaveRun: true }],
			["noncanonical sandbox root", { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app/", commandMayHaveRun: true }],
			["ABI below minimum", { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 4, launcherVersion: "3", sandboxRoot: "/opt/app", commandMayHaveRun: true }],
			["partial enforcement", { mode: "workspace_write", backend: "landlock", enforcement: "partial", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app", commandMayHaveRun: true }],
			["confirmed without execution fact", { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app", commandMayHaveRun: false }],
			["unconfirmed with denial claim", { mode: "workspace_write", backend: "landlock", enforcement: "none", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app", commandMayHaveRun: false, denialSuspected: false }],
			["none carrying Landlock ABI", { mode: "workspace_write", backend: "none", enforcement: "none", abi: 5, commandMayHaveRun: false }],
			["Full Access carrying root", { mode: "full_access", backend: "none", enforcement: "none", sandboxRoot: "/opt/app", commandMayHaveRun: true }],
			["Full Access claiming denial", { mode: "full_access", backend: "none", enforcement: "none", commandMayHaveRun: true, denialSuspected: true }],
			["Bubblewrap without version", { mode: "workspace_write", backend: "bubblewrap", enforcement: "full", sandboxRoot: "/opt/app", commandMayHaveRun: true }],
		] as const).map(([name, facts]) => [name, JSON.stringify(facts)] as const),
	] as const)("rejects invalid persisted sandbox facts: %s", async (_name, json) => {
		const f = operationFixture();
		const result = await f.service.submit({ toolCallId: "tool", sessionId: "s", command: "echo x" });
		f.db.prepare("UPDATE command_operations SET sandbox_json = ? WHERE id = ?").run(json, result.operation.id);
		await expect(f.repository.findById(result.operation.id)).rejects.toThrow("Invalid stored command sandbox facts");
	});
	it.each([
		["queued", { mode: "workspace_write", backend: "none", enforcement: "none", commandMayHaveRun: false }],
		["failed", { mode: "full_access", backend: "none", enforcement: "none", commandMayHaveRun: false }],
		["failed", { mode: "full_access", backend: "none", enforcement: "none", commandMayHaveRun: true, denialSuspected: false }],
		["running", { mode: "workspace_write", backend: "landlock", enforcement: "none", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app", commandMayHaveRun: false }],
		["uncertain", { mode: "workspace_write", backend: "landlock", enforcement: "none", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app", commandMayHaveRun: true }],
		["running", { mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
			bubblewrapVersion: "0.12.0", sandboxRoot: "/opt/app", commandMayHaveRun: true }],
	] as const)("preserves historical %s sandbox facts at the SQLite boundary", async (status, facts) => {
		const f = operationFixture();
		const result = await f.service.submit({ toolCallId: "tool", sessionId: "s", command: "echo x" });
		f.db.prepare("UPDATE command_operations SET status = ?, sandbox_json = ? WHERE id = ?")
			.run(status, JSON.stringify(facts), result.operation.id);
		await expect(f.repository.findById(result.operation.id)).resolves.toMatchObject({ status, sandbox: facts });
	});
	it("keeps pre-sandbox operations as unknown instead of inventing protection", async () => {
		const f = operationFixture();
		const result = await f.service.submit({ toolCallId: "tool", sessionId: "s", command: "echo x" });
		f.db.prepare("UPDATE command_operations SET sandbox_json = NULL WHERE id = ?").run(result.operation.id);
		expect((await f.repository.findById(result.operation.id))?.sandbox).toBeUndefined();
	});
 it("persists actual confinement facts and hides launcher protocol from output", async () => {
  const f = operationFixture(); const result = await f.service.submit({ toolCallId: "tool", sessionId: "s", command: "echo x" });
  expect(result.operation).toMatchObject({ status: "completed", sandbox: { mode: "workspace_write", enforcement: "full", abi: 5, commandMayHaveRun: true } });
  expect(result.outputTail).toBe("");
  expect(await f.repository.findById(result.operation.id)).toMatchObject({ sandbox: result.operation.sandbox });
 });
 it("accepts confirmation after remote shell diagnostics while preserving them", async () => {
  const f = operationFixture(); f.broker.execute.mockImplementationOnce(async (input) => {
   await input.onStderr(Buffer.from("shell warning\ngori-landlock: conf"));
   await input.onStderr(Buffer.from("ined abi=5\ncommand output\n")); return { exitCode: 0 };
  });
  const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo x" });
  expect(result.operation.sandbox?.enforcement).toBe("full");
  expect(result.outputTail).toBe("shell warning\ncommand output\n");
 });
	it("ignores a marker embedded in a diagnostic before the launcher's own line", async () => {
		const f = operationFixture(); f.broker.execute.mockImplementationOnce(async (input) => {
			await input.onStderr(Buffer.from("warning: gori-landlock: confined abi=5\ngori-landlock: confined abi=5\n"));
			return { exitCode: 0 };
		});
		const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo x" });
		expect(result.operation.sandbox?.enforcement).toBe("full");
		expect(result.outputTail).toBe("warning: gori-landlock: confined abi=5\n");
	});
	it("does not accept a startup line with a different confirmation nonce", async () => {
		const f = operationFixture({ sandbox: {
			prepareTerminal: async () => { throw new Error("Unexpected Terminal preparation"); },
			prepare: async () => ({ command: "confined echo x",
				sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app" },
				confirmation: "gori-landlock: confined abi=5 token=0123456789abcdef0123456789abcdef\n" }),
		} });
		f.broker.execute.mockImplementationOnce(async (input) => {
			await input.onStderr(Buffer.from("gori-landlock: confined abi=5 token=ffffffffffffffffffffffffffffffff\n"));
			return { exitCode: 125 };
		});
		const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo x" });
		expect(result.operation).toMatchObject({ failure: { code: "sandbox_confirmation_missing" }, sandbox: { enforcement: "none", commandMayHaveRun: true } });
	});
	it("records possible execution when SSH closes before confinement is confirmed", async () => {
		const f = operationFixture();
		f.broker.execute.mockRejectedValueOnce(new Error("SSH channel closed"));
		const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo x" });
		expect(result.operation).toMatchObject({ status: "failed", sandbox: { enforcement: "none", commandMayHaveRun: true } });
		expect(await f.repository.findById(result.operation.id)).toMatchObject({ sandbox: { commandMayHaveRun: true } });
	});
 it.each([false, true])("does not dispatch when sandbox preparation is unavailable (missing provider=%s)", async (noProvider) => {
  const f = operationFixture({ noProvider, sandbox: { prepareTerminal: async () => { throw new Error("Unexpected Terminal preparation"); }, prepare: async () => { throw sandboxFailure("sandbox_probe_failed", "not available"); } } });
  const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo must not run" });
  expect(result.operation.status).toBe("failed"); expect(result.operation.sandbox?.commandMayHaveRun).toBe(false);
  expect(f.broker.execute).not.toHaveBeenCalled();
 });
 it("does not treat missing confirmation or exit 125 as successful confinement", async () => {
  const f = operationFixture(); f.broker.execute.mockImplementationOnce(async () => ({ exitCode: 125 }));
  const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo x" });
  expect(result.operation).toMatchObject({ exitCode: 125, failure: { code: "sandbox_confirmation_missing" }, sandbox: { enforcement: "none", commandMayHaveRun: true } });
  expect(f.broker.execute).toHaveBeenCalledOnce();
 });
	it("does not accept an empty confirmation marker", async () => {
		const f = operationFixture({ sandbox: { prepareTerminal: async () => { throw new Error("Unexpected Terminal preparation"); }, prepare: async () => ({
			command: "confined echo x",
			sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, sandboxRoot: "/opt/app" },
			confirmation: "",
		}) } });
		const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo x" });
		expect(result.operation).toMatchObject({ failure: { code: "sandbox_confirmation_missing" }, sandbox: { enforcement: "none", commandMayHaveRun: true } });
	});
 it("returns suspected denial with partial-effect semantics and never retries", async () => {
  const f = operationFixture(); f.broker.execute.mockImplementationOnce(async (input) => {
   await input.onStderr(Buffer.from("gori-landlock: confined abi=5\ncp: Permission denied\n"));
   await input.onStdout(Buffer.from("first write succeeded\n")); return { exitCode: 1 };
  });
  const result = await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo ok > ./x; cp x /etc/x" });
  expect(result.operation).toMatchObject({ failure: { code: "sandbox_denied", retryable: false }, sandbox: { denialSuspected: true, commandMayHaveRun: true, enforcement: "full" } });
  expect(f.broker.execute).toHaveBeenCalledOnce(); expect(result.outputTail).toContain("first write succeeded");
 });
 it("forces human approval despite autoAudit and grants only the matching request", async () => {
  const f = operationFixture(); const approval = vi.fn(async () => ({ approved: true as const, source: "user" as const }));
  const coordinator = new ChatToolCallCoordinator({ authorization: f.policy, approvals: { request: approval } });
  await coordinator.beforeToolCall({ run: f.run, toolCallId: "tool", toolName: "remote_server_call", assistantMessageId: "message",
   args: { command: request.command, sandbox_permissions: "full_access", justification: request.justification }, onApprovalRejection: vi.fn() });
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: false, descriptionMessage: { key: "approval.remote_full_access", values: { justification: request.justification } } }), undefined);
  expect((await f.service.submit(fullInput)).operation).toMatchObject({ status: "completed", sandbox: { mode: "full_access", enforcement: "none", backend: "none" } });
  expect((await f.service.submit(fullInput)).operation.failure?.code).toBe("sandbox_approval_required"); expect(f.broker.execute).toHaveBeenCalledOnce();
 });
	it("keeps both automatic and manually approved ordinary commands sandboxed", async () => {
		const f = operationFixture();
		const approval = vi.fn(async (input: { autoApprove: boolean }) => ({
			approved: true as const, source: input.autoApprove ? "auto" as const : "user" as const,
		}));
		const coordinator = new ChatToolCallCoordinator({ authorization: f.policy, approvals: { request: approval } });
		const tool = createRemoteServerCallTool({ sessionId: "s", agentRunId: "run", operations: f.service });
		const command = "cat /etc/os-release";

		const automatic = await coordinator.beforeToolCall({ run: f.run, toolCallId: "automatic", toolName: "remote_server_call",
			assistantMessageId: "message-1", args: { command }, onApprovalRejection: vi.fn() });
		await expect(tool.execute("automatic", { command }, undefined, undefined, automatic?.executionContext)).resolves.toMatchObject({
			details: { status: "completed", sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full" } },
		});
		expect(f.broker.execute).toHaveBeenCalledOnce();

		f.db.prepare("UPDATE sessions SET auto_audit = 0 WHERE id = 's'").run();
		const manual = await coordinator.beforeToolCall({ run: f.run, toolCallId: "manual", toolName: "remote_server_call",
			assistantMessageId: "message-2", args: { command }, onApprovalRejection: vi.fn() });
		expect(approval).toHaveBeenLastCalledWith(expect.objectContaining({ autoApprove: false,
			descriptionMessage: { key: "approval.remote_sandboxed_command" } }), undefined);
		await expect(tool.execute("manual", { command }, undefined, undefined, manual?.executionContext)).resolves.toMatchObject({
			details: { status: "completed", sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full" } },
		});
		expect(f.sandbox.prepare).toHaveBeenCalledTimes(2);
		expect(f.broker.execute).toHaveBeenCalledTimes(2);
		expect(f.approvals.consume({ agentRunId: "run", toolCallId: "manual", sessionId: "s", command,
			justification: "No Full Access approval was issued" })).toBe(false);
	});
	it("runs a marked sandbox exception only after human approval even when autoAudit is enabled", async () => {
		const f = operationFixture({ remoteRoute: "outside" });
		const approval = vi.fn(async () => ({ approved: true as const, source: "user" as const }));
		const coordinator = new ChatToolCallCoordinator({ authorization: f.policy, approvals: { request: approval } });
		const tool = createRemoteServerCallTool({ sessionId: "s", agentRunId: "run", operations: f.service });
		const command = "write /etc/app";
		const approved = await coordinator.beforeToolCall({ run: f.run, toolCallId: "exception", toolName: "remote_server_call",
			assistantMessageId: "message", args: { command, write_paths: ["/etc/app"] }, onApprovalRejection: vi.fn() });
		expect(approval).toHaveBeenCalledWith(expect.objectContaining({
			toolName: "remote_sandbox_exception", autoApprove: false,
			descriptionMessage: { key: "approval.remote_sandbox_exception",
				values: { reason: "Declared path /etc/app is outside the writable roots" } },
		}), undefined);
		await expect(tool.execute("exception", { command, write_paths: ["/etc/app"] },
			undefined, undefined, approved?.executionContext)).resolves.toMatchObject({
			details: { sandbox: { mode: "full_access", backend: "none", enforcement: "none" } },
		});
		expect(f.broker.execute).toHaveBeenCalledOnce();
		// The same plan cannot replace the consumed grant, nor silently fall back to the sandbox.
		await expect(tool.execute("exception", { command, write_paths: ["/etc/app"] },
			undefined, undefined, approved?.executionContext)).rejects.toMatchObject({
			details: { failure: { code: "sandbox_approval_required" }, sandbox: { mode: "full_access" } },
		});
		expect(f.broker.execute).toHaveBeenCalledOnce();
	});
 it("rejects full access without approval and after human rejection", async () => {
  const f = operationFixture(); const prepared = await f.policy.prepare({ run: f.run, toolCallId: "tool", toolName: "remote_server_call", args: { command: request.command, sandbox_permissions: "full_access", justification: request.justification } });
  f.policy.recordDecision(prepared, false);
  expect((await f.service.submit(fullInput)).operation.failure?.code).toBe("sandbox_approval_required"); expect(f.broker.execute).not.toHaveBeenCalled();
 });
 it("does not grant full access when an approval provider returns an automatic decision", async () => {
  const f = operationFixture();
  const coordinator = new ChatToolCallCoordinator({ authorization: f.policy,
   approvals: { request: async () => ({ approved: true, source: "auto" }) } });
  expect(await coordinator.beforeToolCall({ run: f.run, toolCallId: "tool", toolName: "remote_server_call", assistantMessageId: "m",
   args: { command: request.command, sandbox_permissions: "full_access", justification: request.justification }, onApprovalRejection: vi.fn() })).toMatchObject({ block: true });
  expect((await f.service.submit(fullInput)).operation.failure?.code).toBe("sandbox_approval_required");
  expect(f.broker.execute).not.toHaveBeenCalled();
 });
 it("binds approval to run, tool, session, command, cwd, timeout and justification", async () => {
  for (const change of [{ agentRunId: "other" }, { toolCallId: "other" }, { command: "changed" }, { cwd: "/etc" }, { timeoutMs: 1 }, { justification: "changed" }]) {
   const f = operationFixture(); f.approvals.approve(request);
   expect((await f.service.submit({ ...fullInput, ...change })).operation.failure?.code).toBe("sandbox_approval_required"); expect(f.broker.execute).not.toHaveBeenCalled();
  }
  const grants = new RemoteSandboxApprovalStore(); grants.approve(request);
  expect(grants.consume({ ...request, sessionId: "other" })).toBe(false);
 });
 it("rejects a queued Full Access command when its approved SSH target changes", async () => {
  const f = operationFixture(); f.approvals.approve(request);
  const result = await f.service.submit({ ...fullInput, expectedTarget: { ...target, workspaceRevision: target.workspaceRevision + 1 } });
  expect(result.operation.failure?.code).toBe("invalid_request");
  expect(f.broker.execute).not.toHaveBeenCalled();
 });
 it("clears unused grants when the run ends", async () => {
  const f = operationFixture(); f.approvals.approve(request); f.policy.clearRun("run");
  expect((await f.service.submit(fullInput)).operation.failure?.code).toBe("sandbox_approval_required");
 });
 it("blocks before approval and blocks an approved call when Guard changes", async () => {
  const f = operationFixture(); f.approvals.approve(request); f.block();
  const prepared = await f.policy.prepare({ run: f.run, toolCallId: "tool", toolName: "remote_server_call", args: { command: request.command, sandbox_permissions: "full_access", justification: request.justification } });
  expect(prepared.kind).toBe("block"); expect((await f.service.submit(fullInput)).operation.failure?.code).toBe("guard_blocked"); expect(f.broker.execute).not.toHaveBeenCalled();
 });
 it("rechecks Guard after sandbox preparation and before dispatch", async () => {
  const f = operationFixture(); const original = vi.mocked(f.sandbox.prepare).getMockImplementation();
  if (!original) throw new Error("Missing prepare implementation");
  vi.spyOn(f.sandbox, "prepare").mockImplementation(async (input) => { const result = await original(input); f.block(); return result; });
  expect((await f.service.submit({ toolCallId: "t", sessionId: "s", command: "echo x" })).operation.failure?.code).toBe("guard_blocked"); expect(f.broker.execute).not.toHaveBeenCalled();
 });
 it("requires justification before approval", async () => {
  const f = operationFixture();
  expect((await f.policy.prepare({ run: f.run, toolCallId: "tool", toolName: "remote_server_call", args: { command: "echo x", sandbox_permissions: "full_access" } })).kind).toBe("block");
  await expect(f.service.submit({ ...fullInput, justification: " " })).rejects.toMatchObject({ failure: { code: "invalid_request" } });
 });
});
