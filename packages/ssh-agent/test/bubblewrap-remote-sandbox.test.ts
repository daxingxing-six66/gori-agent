import { describe, expect, it, vi } from "vitest";
import type { RemoteCommandBroker } from "../src/application/ssh-channel-broker.ts";
import { BubblewrapRemoteSandboxProvider } from "../src/infrastructure/sandbox/bubblewrap-remote-sandbox-provider.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target = {
	workspaceId: "workspace-1", defaultCwd: "/srv/app", hostname: "host", port: 22,
	credentialId: "credential-1", credentialAuthVersion: 1, workspaceRevision: 1,
} as SshTargetSnapshot;

function broker(options: { installed?: boolean; version?: string; probeSucceeds?: boolean; root?: string; hostPidNamespace?: string; hostNetworkNamespace?: string } = {}) {
	const commands: string[] = [];
	const execute: RemoteCommandBroker["execute"] = vi.fn(async (input) => {
		commands.push(input.command);
		let output = "";
		if (input.command === "uname -s") output = "Linux\n";
		else if (input.command.startsWith("p=$(command -v bwrap)")) output = options.installed === false
			? "missing\n"
			: `path=/usr/bin/bwrap\nstat=0:755\nstat=0:755\nstat=0:755\nstat=0:755\nbubblewrap ${options.version ?? "0.12.0"}\n`;
		else if (input.command.startsWith("test -d '/srv/app")) output = `${options.root ?? "/srv/app"}\n`;
		else if (input.command === "readlink /proc/self/ns/pid && readlink /proc/self/ns/net")
			output = `${options.hostPidNamespace ?? "pid:[4026531836]"}\n${options.hostNetworkNamespace ?? "net:[4026531992]"}\n`;
		else if (input.command.includes("realpath -e -- /tmp")) output = "/tmp\n";
		else if (input.command.startsWith("for candidate in /var/tmp")) output = "/var/tmp\n";
		else if (input.command.includes("gori-bubblewrap-probe")) {
			if (options.probeSucceeds === false) return { exitCode: 1 };
			output = "gori-bubblewrap-probe";
		}
		if (output) await input.onStdout(Buffer.from(output));
		return { exitCode: 0 };
	});
	return { commands, execute };
}

describe("Bubblewrap remote sandbox", () => {
	it("probes an installed runner without approval and prepares a confined command and Terminal", async () => {
		const remote = broker();
		const sandbox = new BubblewrapRemoteSandboxProvider({ broker: remote });
		const signal = new AbortController().signal;
		const prepared = await sandbox.prepare({ target, cwd: "/srv/app", command: "echo ready", signal });
		expect(prepared.sandbox).toEqual({ mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
			bubblewrapVersion: "0.12.0", sandboxRoot: "/srv/app" });
		expect(prepared.command).toContain("'--ro-bind' '/' '/'");
		expect(prepared.command).toContain("'--bind' '/srv/app' '/srv/app'");
		expect(prepared.command).toContain("'--ro-bind' '/proc' '/proc'");
		expect(prepared.command).toContain("'--new-session'");
		expect(prepared.command).not.toMatch(/--unshare-(user|pid|net)|--die-with-parent|--proc/);
		expect(prepared.command).toContain("echo ready");
		expect(prepared.confirmation).toMatch(/^gori-bubblewrap: confined version=0\.12\.0 token=[0-9a-f]{32}\n$/);
		expect(remote.commands.every((command) => !command.includes("echo ready"))).toBe(true);
		expect(remote.commands.some((command) => command.includes("set -C; : >") && command.includes(".gori-bwrap-probe-"))).toBe(true);
		expect(remote.commands.some((command) => command.includes("&& { if (: >>") && command.includes("gori-bubblewrap-probe; }"))).toBe(true);
		expect(remote.commands.some((command) => command.startsWith("GORI_HOST_PROBE_PID=$$ ") &&
			command.includes("readlink /proc/self/ns/pid") && command.includes("readlink /proc/self/ns/net") &&
			command.includes("kill -0") && command.includes("'pid:[4026531836]'") &&
			command.includes("'net:[4026531992]'"))).toBe(true);
		expect(remote.commands.some((command) => command.startsWith("rm -f --") && command.includes(".gori-bwrap-probe-"))).toBe(true);
		const terminal = await sandbox.prepareTerminal({ target, signal });
		expect(terminal.sandbox.backend).toBe("bubblewrap");
		expect(terminal.command).toContain("exec /bin/bash --login -i");
		expect(terminal.command).toContain("'--ro-bind' '/proc' '/proc'");
		expect(terminal.command).not.toMatch(/--unshare-(user|pid|net)|--die-with-parent|--proc/);
	});

	it("distinguishes missing installation from an installed but unusable runner", async () => {
		const missing = new BubblewrapRemoteSandboxProvider({ broker: broker({ installed: false }) });
		await expect(missing.probe(target, new AbortController().signal))
			.rejects.toMatchObject({ failure: { code: "sandbox_bubblewrap_not_installed" } });
		const unusable = new BubblewrapRemoteSandboxProvider({ broker: broker({ probeSucceeds: false }) });
		await expect(unusable.probe(target, new AbortController().signal))
			.rejects.toMatchObject({ failure: { code: "sandbox_unavailable" } });
		const old = new BubblewrapRemoteSandboxProvider({ broker: broker({ version: "0.11.0" }) });
		await expect(old.probe(target, new AbortController().signal))
			.rejects.toMatchObject({ failure: { code: "sandbox_partial_enforcement" } });
		const noPidView = new BubblewrapRemoteSandboxProvider({ broker: broker({ hostPidNamespace: "unavailable" }) });
		await expect(noPidView.probe(target, new AbortController().signal))
			.rejects.toMatchObject({ failure: { code: "sandbox_probe_failed" } });
		const noNetworkView = new BubblewrapRemoteSandboxProvider({ broker: broker({ hostNetworkNamespace: "unavailable" }) });
		await expect(noNetworkView.probe(target, new AbortController().signal))
			.rejects.toMatchObject({ failure: { code: "sandbox_probe_failed" } });
	});

	it("preserves a canonical writable root with trailing spaces", async () => {
		const sandbox = new BubblewrapRemoteSandboxProvider({ broker: broker({ root: "/srv/app " }) });
		const prepared = await sandbox.prepare({ target: { ...target, defaultCwd: "/srv/app " },
			cwd: "/srv/app ", command: "true", signal: new AbortController().signal });
		expect(prepared.sandbox.sandboxRoot).toBe("/srv/app ");
		expect(prepared.command).toContain("'--bind' '/srv/app ' '/srv/app '");
	});
});
