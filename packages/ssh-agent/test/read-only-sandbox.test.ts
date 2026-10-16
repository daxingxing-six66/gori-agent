import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { RemoteCommandBroker } from "../src/application/ssh-channel-broker.ts";
import { prepareRemoteCommandAuthorization } from "../src/application/tools/remote-server-call-tool.ts";
import { ChatAgentRuntimeFactory } from "../src/application/services/chat-agent-runtime-factory.ts";
import { sessionSandboxInstructions } from "../src/application/services/session-sandbox-policy.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import { LandlockRemoteSandboxProvider } from "../src/infrastructure/sandbox/landlock-remote-sandbox-provider.ts";
import { BubblewrapRemoteSandboxProvider } from "../src/infrastructure/sandbox/bubblewrap-remote-sandbox-provider.ts";
import { RemoteSandboxCoordinator } from "../src/infrastructure/sandbox/remote-sandbox-coordinator.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { testSshTarget } from "./test-ssh-target.ts";

const target = testSshTarget({ sandboxReadOnly: true, sandboxWritableRoots: ["/srv/app"] });
const signal = new AbortController().signal;
const run: ChatRun = { id: "run", sessionId: "session", workspaceId: "workspace", requestId: "request",
	providerId: "test", modelId: "test", thinkingLevel: "off", serverInteractionMode: "command",
	terminalSessionId: null, status: "pending", createdAt: 1, updatedAt: 1 };

function remoteHost(launcherPresent = true) {
	const binary = Buffer.from("readonly-test-launcher");
	const digest = createHash("sha256").update(binary).digest("hex");
	const commands: string[] = [];
	const execute: RemoteCommandBroker["execute"] = vi.fn(async (input) => {
		commands.push(input.command);
		let output = "";
		if (input.command === 'uname -s && uname -m && printf "%s\\n" "$HOME"') output = "Linux\nx86_64\n/home/test\n";
		else if (input.command === "uname -s") output = "Linux\n";
		else if (input.command.includes("pwd -P")) {
			if (!launcherPresent) return { exitCode: 1 };
			output = `/home/test/.cache/gori/sandbox/3/${digest}\n`;
		} else if (input.command.includes("sha256sum")) output = `${digest} launcher\n`;
		else if (input.command.includes("'--probe'")) output = "gori-landlock: abi=5 enforcement=full\n";
		else if (input.command.includes("realpath -e") && input.command.startsWith("test -d")) output = "/tmp\n";
		else if (input.command.startsWith("p=$(command -v bwrap)"))
			output = "path=/usr/bin/bwrap\nstat=0:755\nstat=0:755\nstat=0:755\nbubblewrap 0.12.0\n";
		else if (input.command.startsWith("readlink /proc/self/ns/pid")) output = "pid:[123]\nnet:[456]\n";
		else if (input.command.startsWith("for candidate in /var/tmp")) output = "/var/tmp\n";
		else if (input.command.includes("gori-bubblewrap-probe")) output = "gori-bubblewrap-probe";
		if (output) await input.onStdout(Buffer.from(output));
		return { exitCode: 0 };
	});
	return { binary, commands, execute, upload: vi.fn(async () => ({ bytesTransferred: 0 })), deleteFile: vi.fn(async () => {}) };
}

describe("Read-only sandbox boundaries", () => {
	it("reuses a verified launcher without writing its cache and grants no configured workspace roots", async () => {
		const host = remoteHost();
		const provider = new LandlockRemoteSandboxProvider({ broker: host, loadBinary: async () => host.binary });
		const prepared = await provider.prepare({ target, command: "tail /var/log/app.log", cwd: "/var/log", signal });
		expect(prepared.sandbox.sandboxRoots).toEqual(["/tmp"]);
		expect(prepared.command).toContain("'--ro' '/'");
		expect(prepared.command).not.toContain("'--rw' '/srv/app'");
		expect(prepared.command).toContain("'--rw' '/tmp'");
		const terminal = await provider.prepareTerminal({ target, signal });
		expect(terminal.sandbox.sandboxRoots).toEqual(["/tmp"]);
		expect(host.upload).not.toHaveBeenCalled(); expect(host.deleteFile).not.toHaveBeenCalled();
		expect(host.commands.join("\n")).not.toMatch(/mkdir|chmod|mv -fT/);
	});
	it("never installs a missing launcher and can fall back to an already installed Bubblewrap", async () => {
		const host = remoteHost(false);
		const landlock = new LandlockRemoteSandboxProvider({ broker: host, loadBinary: async () => host.binary });
		const provider = new RemoteSandboxCoordinator([landlock, new BubblewrapRemoteSandboxProvider({ broker: host })]);
		const prepared = await provider.prepare({ target, command: "cat /var/log/app.log", cwd: "/var/log",
			policy: { mode: "workspace_write" }, signal });
		expect(prepared.sandbox).toMatchObject({ backend: "bubblewrap", sandboxRoots: ["/tmp"] });
		expect(prepared.command).not.toContain("'--bind' '/srv/app'");
		expect(host.upload).not.toHaveBeenCalled();
		expect(host.commands.join("\n")).not.toMatch(/mkdir|chmod|mv -fT|\.gori-bwrap-probe-/);
		const probe = host.commands.find((command) => command.startsWith("GORI_HOST_PROBE_PID=$$"));
		expect(probe).toContain("test ! -w");
		expect(host.commands.filter((command) => command.startsWith("rm -f"))).toEqual([
			expect.stringMatching(/^rm -f -- '\/tmp\/\.gori-bwrap-write-probe-/),
		]);
		await expect(async () => provider.prepare({ target, command: "touch /etc/app", cwd: "/",
			policy: { mode: "full_access" }, signal })).rejects.toMatchObject({ failure: { code: "invalid_request" } });
	});
	it.each(["explicit", "outside", "unavailable"])("rejects %s Full Access before requesting approval", async (kind) => {
		const authorization = { readOnly: async () => true, sandboxEnabled: async () => true, autoApprove: vi.fn(async () => true),
			preflightGuard: async () => ({ allowed: true }),
			assessSandbox: async () => ({ target, route: { mode: "full_access" as const,
				reason: kind === "outside" ? "write_path_outside_sandbox" as const : "sandbox_unavailable" as const, details: kind } }) };
		await expect(prepareRemoteCommandAuthorization({ run, toolName: "remote_server_call", toolCallId: "call",
			args: { command: "inspect", ...(kind === "explicit" ? { sandbox_permissions: "full_access", justification: "needed" } : {}) } }, authorization))
			.rejects.toMatchObject({ terminate: false });
		expect(authorization.autoApprove).not.toHaveBeenCalled();
	});
	it("permits ordinary confined log reads while keeping the Full Access prohibition in trusted instructions", async () => {
		const prepared = await prepareRemoteCommandAuthorization({ run, toolName: "remote_server_call", toolCallId: "call",
			args: { command: "tail /var/log/app.log" } }, {
			readOnly: async () => true, autoApprove: async () => true, preflightGuard: async () => ({ allowed: true }),
			assessSandbox: async () => ({ target, route: { mode: "workspace_write", facts: { mode: "workspace_write",
				backend: "landlock", enforcement: "full", sandboxRoot: "/tmp", sandboxRoots: ["/tmp"] } } }),
		});
		expect(prepared).toMatchObject({ kind: "approval", autoApprove: true });
		expect(sessionSandboxInstructions("workspace_write", ["/srv/app"], true)).toContain("Full Access exceptions");
		expect(sessionSandboxInstructions("workspace_write", ["/srv/app"], true)).not.toContain("/srv/app");
	});
	it("upgrades a populated database without changing revisions or history and survives reopening", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gori-readonly-"));
		const file = join(directory, "test.sqlite");
		let db = new DatabaseSync(file);
		try {
			db.exec(readFileSync(new URL("./fixtures/schema-v27-sandbox.sql", import.meta.url), "utf8"));
			applyMigrations(db);
			const repository = new SqliteSessionRepository(db);
			const row = db.prepare("SELECT id FROM sessions LIMIT 1").get();
			if (!row || typeof row.id !== "string") throw new Error("Missing legacy Session");
			const session = await repository.findById(row.id);
			if (!session) throw new Error("Missing migrated Session");
			expect(session.sandboxReadOnly).toBe(false);
			const history = db.prepare("SELECT message_json FROM chat_messages ORDER BY id").all();
			await repository.update({ ...session, sandboxEnabled: true, sandboxReadOnly: true }, session.revision);
			db.close(); db = new DatabaseSync(file); applyMigrations(db);
			expect(await new SqliteSessionRepository(db).findById(session.id)).toMatchObject({ sandboxReadOnly: true, revision: session.revision });
			expect(db.prepare("SELECT message_json FROM chat_messages ORDER BY id").all()).toEqual(history);
		} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
	});
	it("blocks upload and installation tools at runtime while keeping log reads and downloads available", async () => {
		const namedTool = (name: string): AgentTool => ({ name, label: name, description: name, parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }) });
		const faux = fauxProvider({ provider: "readonly-test", models: [{ id: "test" }] });
		const models = createModels(); models.setProvider(faux.provider);
		let agent: Agent | undefined;
		const factory = new ChatAgentRuntimeFactory({ models,
			sandboxPolicy: { mode: async () => "workspace_write", readOnly: async () => true },
			toolCalls: { beforeToolCall: async () => undefined, requestSftpOverwriteApproval: async () => ({ approved: true, source: "user" }) },
			queues: { cancelSteeringAfterTurn: () => {} }, agentEvents: { handle: () => {} },
			attachments: { hydrateProviderContext: async (_id, context) => context }, decisions: { request: async () => [] },
			createRemoteTool: () => namedTool("remote_server_call"), createTerminalTool: () => namedTool("terminal_interaction"),
			createSftpTool: () => namedTool("sftp_upload"), createSftpDownloadTool: () => namedTool("sftp_download"),
			createAgent: (options) => { agent = new Agent(options); return agent; },
		});
		const runtime = await factory.create({ systemPrompt: "test", run, model: faux.getModel(), workDir: tmpdir(), history: [] });
		try {
			const upload = agent?.state.tools.find((tool) => tool.name === "sftp_upload");
			await expect(upload?.execute("call", {})).rejects.toMatchObject({ terminate: false });
			const install = agent?.state.tools.find((tool) => tool.name === "bubblewrap_install");
			await expect(install?.execute("call", {})).rejects.toMatchObject({ terminate: false });
			await expect(agent?.state.tools.find((tool) => tool.name === "sftp_download")?.execute("call", {})).resolves.toBeDefined();
			await expect(agent?.state.tools.find((tool) => tool.name === "remote_server_call")?.execute("call", {})).resolves.toBeDefined();
		} finally { await runtime.dispose(); }
	});
});
