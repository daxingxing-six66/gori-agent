import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExecuteRemoteCommandInput } from "../src/application/ssh-channel-broker.ts";
import { evaluateRemoteSandboxRoute } from "../src/application/services/remote-sandbox-routing.ts";
import { LandlockRemoteSandboxProvider } from "../src/infrastructure/sandbox/landlock-remote-sandbox-provider.ts";
import { BubblewrapRemoteSandboxProvider } from "../src/infrastructure/sandbox/bubblewrap-remote-sandbox-provider.ts";
import { shellArgv } from "../src/infrastructure/sandbox/shell-command.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target: SshTargetSnapshot = { workspaceId: "w", workspaceRevision: 1, hostname: "fixture.invalid", port: 22,
	hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:fixture", credentialId: "c", credentialAuthVersion: 1,
	remoteUser: "fixture",  sandboxWritableRoots: ["/srv/app", "/var/log/app"],
	connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
const digest = createHash("sha256").update("synthetic launcher").digest("hex");
function fixture(backend: "landlock" | "bubblewrap", canonical = new Map<string, string>()) {
	const execute = vi.fn(async (input: ExecuteRemoteCommandInput) => {
		let output = "";
		const root = /realpath -e -- '([^']+)'$/.exec(input.command)?.[1];
		if (input.command === "test -d /tmp && realpath -e -- /tmp") output = "/tmp\n";
		else if (root) { if (root === "/missing") return { exitCode: 1 }; output = `${canonical.get(root) ?? root}\n`; }
		else if (input.command.startsWith("uname -s &&")) output = "Linux\nx86_64\n/home/fixture\n";
		else if (input.command === "uname -s") output = "Linux\n";
		else if (input.command.includes("pwd -P")) output = `/home/fixture/.cache/gori/sandbox/3/${digest}\n`;
		else if (input.command.startsWith("sha256sum")) output = `${digest}  launcher\n`;
		else if (input.command.includes("'--probe'")) output = "gori-landlock: abi=8 enforcement=full\n";
		else if (input.command.startsWith("p=$(command -v bwrap)")) output = "path=/usr/bin/bwrap\nstat=0:755\nstat=0:755\nstat=0:755\nbubblewrap 0.12.0\n";
		else if (input.command.startsWith("readlink /proc/self/ns/pid")) output = "pid:[1]\nnet:[2]\n";
		else if (input.command.startsWith("for candidate")) output = "/var/tmp\n/home/fixture\n";
		else if (input.command.startsWith("GORI_HOST_PROBE_PID=$$")) output = "gori-bubblewrap-probe";
		if (output) await input.onStdout(Buffer.from(output));
		return { exitCode: 0 };
	});
	const broker = { execute, upload: async () => { throw new Error("Unexpected upload"); }, deleteFile: async () => {} };
	const provider = backend === "landlock" ? new LandlockRemoteSandboxProvider({ broker, loadBinary: async () => Buffer.from("synthetic launcher") })
		: new BubblewrapRemoteSandboxProvider({ broker });
	return { provider, execute };
}

describe.each(["landlock", "bubblewrap"] as const)("multiple %s writable directories", (backend) => {
	it("enforces both directories for exec and PTY while keeping cwd independent", async () => {
		const { provider, execute } = fixture(backend);
		const signal = new AbortController().signal;
		const prepared = await provider.prepare({ target, command: "echo task", cwd: "/read-only/start", signal });
		const terminal = await provider.prepareTerminal({ target, signal });
		expect(prepared.sandbox).toMatchObject({ sandboxRoot: "/srv/app", sandboxRoots: ["/srv/app", "/var/log/app"] });
		for (const root of target.sandboxWritableRoots ?? []) {
			const rule = backend === "landlock" ? shellArgv(["--rw", root]) : shellArgv(["--bind", root, root]);
			expect(prepared.command).toContain(rule); expect(terminal.command).toContain(rule);
		}
		expect(terminal.command).toMatch(/^exec /);
		expect(prepared.command).not.toContain(shellArgv(["--rw", "/read-only/start"]));
		expect(prepared.command).not.toContain(shellArgv(["--bind", "/read-only/start", "/read-only/start"]));
		expect(execute.mock.calls.some(([input]) => input.command.includes("echo task"))).toBe(false);
		if (backend === "bubblewrap") {
			const probe = execute.mock.calls.find(([input]) => input.command.startsWith("GORI_HOST_PROBE_PID=$$"))?.[0].command;
			expect(probe).toContain("/srv/app/.gori-bwrap-write-probe-"); expect(probe).toContain("/var/log/app/.gori-bwrap-write-probe-");
		}
	});
	it("canonicalizes every selected directory remotely and deduplicates aliases", async () => {
		const { provider } = fixture(backend, new Map([["/alias/app", "/srv/app"], ["/alias/logs", "/var/log/app"]]));
		const facts = await provider.getCapabilities({ ...target, sandboxWritableRoots: ["/srv/app", "/alias/app", "/alias/logs"] }, new AbortController().signal);
		expect(facts.sandboxRoots).toEqual(["/srv/app", "/var/log/app"]);
	});
	it.each(["/missing", "/alias/root", "/alias/launcher"])("fails closed when the second directory is unsafe: %s", async (second) => {
		const protectedRoot = backend === "landlock" ? "/home/fixture" : "/usr";
		const { provider, execute } = fixture(backend, new Map([["/alias/root", "/"], ["/alias/launcher", protectedRoot]]));
		await expect(provider.prepare({ target: { ...target, sandboxWritableRoots: ["/srv/app", second] }, cwd: "/read-only/start",
			command: "echo must-not-run", signal: new AbortController().signal })).rejects.toMatchObject({ failure: {
			code: second === "/missing" ? "sandbox_root_unavailable" : "sandbox_root_invalid", safeDetails: { commandMayHaveRun: false },
		} });
		expect(execute.mock.calls.some(([input]) => input.command.includes("echo must-not-run"))).toBe(false);
	});
	it("recognizes declared writes in the second root without authorizing similarly prefixed neighbors", async () => {
		const { provider } = fixture(backend); const signal = new AbortController().signal;
		await expect(evaluateRemoteSandboxRoute({ sandbox: provider, target, signal, declaredWritePaths: ["/var/log/app/current.log"] })).resolves.toMatchObject({ mode: "workspace_write" });
		await expect(evaluateRemoteSandboxRoute({ sandbox: provider, target, signal, declaredWritePaths: ["/var/log/app-other/out"] })).resolves.toMatchObject({ mode: "full_access", reason: "write_path_outside_sandbox" });
	});
});
it("mounts parent Bubblewrap directories before nested writable paths", async () => {
	const { provider } = fixture("bubblewrap");
	const prepared = await provider.prepare({ target: { ...target, sandboxWritableRoots: ["/srv/app/logs", "/srv/app"] }, cwd: "/read-only/start", command: "true", signal: new AbortController().signal });
	expect(prepared.command.indexOf(shellArgv(["--bind", "/srv/app", "/srv/app"]))).toBeLessThan(prepared.command.indexOf(shellArgv(["--bind", "/srv/app/logs", "/srv/app/logs"])));
});
