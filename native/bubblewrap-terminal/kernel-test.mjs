// Explicit disposable Linux fixture only. No SSH, credentials, SQLite, or model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BubblewrapRemoteSandboxProvider } from "../../packages/ssh-agent/src/infrastructure/sandbox/bubblewrap-remote-sandbox-provider.ts";

assert.equal(process.platform, "linux", "Use a disposable Linux environment");
const directory = mkdtempSync("/tmp/gori-terminal-kernel-");
const outside = mkdtempSync("/var/tmp/gori-terminal-outside-");
try {
	const target = { workspaceId: "synthetic", workspaceRevision: 1, hostname: "fixture.invalid", port: 22,
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:fixture", credentialId: "synthetic",
		credentialAuthVersion: 1, remoteUser: "node", sandboxWritableRoots: [directory],
		connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
	const provider = new BubblewrapRemoteSandboxProvider({ broker: { execute: async (input) => {
		const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", input.command], { timeout: 10000 });
		if (result.error) throw result.error;
		if (result.stdout.length) await input.onStdout(result.stdout);
		if (result.stderr.length) await input.onStderr(result.stderr);
		return { exitCode: result.status, ...(result.signal ? { exitSignal: result.signal } : {}) };
	} } });
	const signal = AbortSignal.timeout(60000);
	const normal = await provider.prepareTerminal({ target, signal });
	const readOnly = await provider.prepareTerminal({ target: { ...target, sandboxReadOnly: true }, signal });
	const command = await provider.prepare({ target, cwd: directory, command: "printf ordinary-command", signal });
	const ordinary = spawnSync("/bin/bash", ["-c", command.command], { encoding: "utf8", timeout: 10000 });
	assert.equal(ordinary.status, 0, ordinary.stderr);
	assert.equal(ordinary.stdout, "ordinary-command");
	assert(command.command.includes("--new-session"));
	const specification = join(directory, "specification.json");
	writeFileSync(specification, JSON.stringify({ normal, readOnly, directory, outside }));
	const result = spawnSync("python3", [fileURLToPath(new URL("./kernel-test.py", import.meta.url)), specification],
		{ stdio: "inherit", timeout: 60000 });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, "PTY kernel regression failed");
} finally {
	rmSync(directory, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
}
