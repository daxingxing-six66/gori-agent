import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { PreparedRemoteTerminal, PreparedSandboxedExecution, RemoteSandboxBackend } from "../../application/services/remote-sandbox-provider.ts";
import type { RemoteCommandBroker, SshConnectionPoolControl } from "../../application/ssh-channel-broker.ts";
import { canonicalRemoteSandboxRoot, sandboxFailure, validRemoteSandboxRoot } from "../../domain/remote-sandbox.ts";
import type { SshFailureCode } from "../../domain/ssh-failure.ts";
import { connectionKeyFor, serializeConnectionKey, type SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { quoteShell, shellArgv, wrapRemoteCommand } from "./shell-command.ts";

type Broker = RemoteCommandBroker & Partial<Pick<SshConnectionPoolControl, "snapshotWorkspace">>;
interface Runner { path: string; version: string; }
interface Rules { runner: Runner; sandboxRoot: string; }

/** Uses an installed, unprivileged Bubblewrap. No package operation occurs here. */
export class BubblewrapRemoteSandboxProvider implements RemoteSandboxBackend {
	readonly #broker: Broker;
	readonly #capabilities = new Map<string, { generation: number; runner: Runner }>();
	readonly #preparing = new Map<string, Promise<Runner>>();

	constructor(options: { broker: Broker }) { this.#broker = options.broker; }

	async probe(target: SshTargetSnapshot, signal: AbortSignal): Promise<PreparedSandboxedExecution["sandbox"]> {
		const key = serializeConnectionKey(connectionKeyFor(target));
		await this.#preparing.get(key)?.catch(() => {});
		signal.throwIfAborted();
		this.#capabilities.delete(key);
		return (await this.prepare({ target, cwd: "/", command: "true", signal })).sandbox;
	}

	async prepare(input: Parameters<RemoteSandboxBackend["prepare"]>[0]): Promise<PreparedSandboxedExecution> {
		const { runner, sandboxRoot } = await this.#prepareRules(input.target, input.signal);
		const token = randomBytes(16).toString("hex");
		const marker = `gori-bubblewrap: confined version=${runner.version} token=${token}\n`;
		const script = `printf %s ${quoteShell(marker)} >&2; ${wrapRemoteCommand(input.cwd, input.command)}`;
		return {
			command: shellArgv([...sandboxArgs(runner.path, sandboxRoot), "--", "/bin/bash", "--noprofile", "--norc", "-c", script]),
			sandbox: { mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
				bubblewrapVersion: runner.version, sandboxRoot },
			confirmation: marker,
		};
	}

	async prepareTerminal(input: Parameters<RemoteSandboxBackend["prepareTerminal"]>[0]): Promise<PreparedRemoteTerminal> {
		const { runner, sandboxRoot } = await this.#prepareRules(input.target, input.signal);
		const token = randomBytes(16).toString("hex");
		const marker = `gori-bubblewrap: confined version=${runner.version} token=${token}`;
		const script = `printf '%s\\n' ${quoteShell(marker)} >&2; exec /bin/bash --login -i`;
		return {
			command: `cd -- ${quoteShell(sandboxRoot)} && exec ${shellArgv([...sandboxArgs(runner.path, sandboxRoot), "--", "/bin/bash", "--noprofile", "--norc", "-c", script])}`,
			sandbox: { mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
				bubblewrapVersion: runner.version, sandboxRoot },
			confirmation: marker,
		};
	}

	async #prepareRules(target: SshTargetSnapshot, inputSignal: AbortSignal): Promise<Rules> {
		const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(30_000)]);
		// Check backend availability first so a missing installation has one distinct result.
		const runner = await this.#ensureRunner(target, signal);
		const root = target.defaultCwd;
		if (!validRemoteSandboxRoot(root)) throw sandboxFailure("sandbox_root_invalid",
			"Configure a remote working directory other than / before using workspace_write. The command was not executed.");
		const canonical = (await this.#checked(target, signal,
			`test -d ${quoteShell(root)} && test -r ${quoteShell(root)} && test -x ${quoteShell(root)} && realpath -e -- ${quoteShell(root)}`,
			"sandbox_root_unavailable")).replace(/\n$/, "");
		if (!canonicalRemoteSandboxRoot(canonical)) throw sandboxFailure("sandbox_root_invalid",
			"Remote sandbox root could not be safely canonicalized. The command was not executed.");
		const temporaryRoot = (await this.#checked(target, signal, "test -d /tmp && realpath -e -- /tmp",
			"sandbox_prepare_failed")).replace(/\n$/, "");
		if (temporaryRoot !== "/tmp") throw sandboxFailure("sandbox_prepare_failed",
			"Remote temporary directory is unsafe. The command was not executed.");
		await this.#checked(target, signal, 'test -c /dev/null && test "$(stat -Lc "%t:%T" -- /dev/null)" = "1:3"',
			"sandbox_prepare_failed");
		const [hostPidNamespace, hostNetworkNamespace] = (await this.#checked(target, signal,
			"readlink /proc/self/ns/pid && readlink /proc/self/ns/net", "sandbox_probe_failed")).trimEnd().split("\n");
		if (!/^pid:\[\d+\]$/.test(hostPidNamespace ?? "") || !/^net:\[\d+\]$/.test(hostNetworkNamespace ?? ""))
			throw sandboxFailure("sandbox_probe_failed", "Remote host process and network namespaces could not be verified. The command was not executed.");
		if (isWithin(runner.path, canonical) || isWithin(runner.path, temporaryRoot))
			throw sandboxFailure("sandbox_root_invalid", "The Bubblewrap executable must be outside writable sandbox roots. The command was not executed.");
		// Use a controlled host-writable file outside the policy to test the actual open-for-write denial.
		const outside = (await this.#checked(target, signal,
			'for candidate in /var/tmp "$HOME" "/run/user/$(id -u)"; do if test -d "$candidate" && test -w "$candidate"; then realpath -e -- "$candidate"; fi; done',
			"sandbox_probe_failed")).replace(/\n$/, "").split("\n").find((candidate) =>
			canonicalRemoteSandboxRoot(candidate) && !isWithin(candidate, canonical) && !isWithin(candidate, temporaryRoot));
		if (!outside) throw sandboxFailure("sandbox_probe_failed",
			"No host-writable path outside the sandbox roots was available to verify Bubblewrap confinement. The command was not executed.");
		const sentinel = posix.join(outside, `.gori-bwrap-probe-${randomBytes(16).toString("hex")}`);
		const writableSentinel = posix.join(canonical, `.gori-bwrap-write-probe-${randomBytes(16).toString("hex")}`);
		await this.#checked(target, signal, `umask 077 && (set -C; : > ${quoteShell(sentinel)})`, "sandbox_probe_failed");
		try {
			const probeScript = `umask 077; test "$(readlink /proc/self/ns/pid)" = ${quoteShell(hostPidNamespace)} && test "$(readlink /proc/self/ns/net)" = ${quoteShell(hostNetworkNamespace)} && test -n "$GORI_HOST_PROBE_PID" && test -r "/proc/$GORI_HOST_PROBE_PID/stat" && kill -0 "$GORI_HOST_PROBE_PID" && test -w ${quoteShell(canonical)} && test -w /tmp && test -c /dev/null && test -e ${quoteShell(sentinel)} && (set -C; : > ${quoteShell(writableSentinel)}) && rm -f -- ${quoteShell(writableSentinel)} && (: > /dev/null) && { if (: >> ${quoteShell(sentinel)}) 2>/dev/null; then exit 2; fi; printf gori-bubblewrap-probe; }`;
			const probe = await this.#capture(target, signal,
				`GORI_HOST_PROBE_PID=$$ ${shellArgv([...sandboxArgs(runner.path, canonical), "--", "/bin/bash", "--noprofile", "--norc", "-c", probeScript])}; exit $?`);
			if (probe.exitCode !== 0 || probe.exitSignal || probe.stdout !== "gori-bubblewrap-probe")
				throw sandboxFailure("sandbox_unavailable", "Installed Bubblewrap could not verify host process and network access with the required filesystem policy. The command was not executed.");
		} finally {
			await this.#capture(target, AbortSignal.timeout(1_000), `rm -f -- ${quoteShell(sentinel)} ${quoteShell(writableSentinel)}`).catch(() => {});
		}
		return { runner, sandboxRoot: canonical };
	}

	async #ensureRunner(target: SshTargetSnapshot, signal: AbortSignal): Promise<Runner> {
		const key = serializeConnectionKey(connectionKeyFor(target));
		const generation = this.#broker.snapshotWorkspace?.(target.workspaceId).generation ?? 0;
		const cached = this.#capabilities.get(key);
		if (cached?.generation === generation) return cached.runner;
		const pending = this.#preparing.get(key);
		if (pending) {
			await pending;
			signal.throwIfAborted();
			return this.#ensureRunner(target, signal);
		}
		const preparation = this.#discover(target, signal);
		this.#preparing.set(key, preparation);
		try {
			const runner = await preparation;
			this.#capabilities.set(key, { generation: this.#broker.snapshotWorkspace?.(target.workspaceId).generation ?? 0, runner });
			return runner;
		} finally { this.#preparing.delete(key); }
	}

	async #discover(target: SshTargetSnapshot, signal: AbortSignal): Promise<Runner> {
		const platform = (await this.#checked(target, signal, "uname -s", "sandbox_probe_failed")).trim();
		if (platform !== "Linux") throw sandboxFailure("sandbox_unsupported_platform", "Remote sandbox requires Linux. The command was not executed.");
		const inspect = await this.#capture(target, signal,
			'p=$(command -v bwrap) || { printf "missing\\n"; exit 0; }; p=$(realpath -e -- "$p") || exit 2; printf "path=%s\\n" "$p"; q="$p"; while :; do stat -Lc "stat=%u:%a" -- "$q" || exit 2; [ "$q" = / ] && break; q=$(dirname -- "$q"); done; "$p" --version');
		if (inspect.exitCode !== 0 || inspect.exitSignal) throw sandboxFailure("sandbox_probe_failed",
			"Bubblewrap executable inspection failed. The command was not executed.");
		if (inspect.stdout === "missing\n") throw sandboxFailure("sandbox_bubblewrap_not_installed",
			"Landlock is unavailable and Bubblewrap is not installed. Installation requires your approval. The command was not executed.");
		const lines = inspect.stdout.trimEnd().split("\n");
		const path = lines.shift()?.slice(5);
		const versionLine = lines.pop();
		if (!path || !canonicalRemoteSandboxRoot(path) || path.includes("\r") ||
			!versionLine || !/^bubblewrap \d+\.\d+\.\d+$/.test(versionLine) ||
			lines.length === 0 || lines.some((line) => {
				const match = /^stat=(\d+):([0-7]{3,4})$/.exec(line);
				if (!match) return true;
				const mode = Number.parseInt(match[2], 8);
				return match[1] !== "0" || (mode & 0o4022) !== 0;
			})) throw sandboxFailure("sandbox_probe_failed",
			"Bubblewrap must be a root-owned, non-setuid executable under root-owned, non-writable directories. The command was not executed.");
		const version = versionLine.slice("bubblewrap ".length);
		const [major, minor, patch] = version.split(".").map(Number);
		if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch) ||
			major < 0 || (major === 0 && minor < 12)) throw sandboxFailure("sandbox_partial_enforcement",
			"Bubblewrap 0.12.0 or later is required. The command was not executed.");
		return { path, version };
	}

	async #checked(target: SshTargetSnapshot, signal: AbortSignal, command: string, code: SshFailureCode): Promise<string> {
		try {
			const result = await this.#capture(target, signal, command);
			if (result.exitCode === 0 && !result.exitSignal) return result.stdout;
		} catch { /* Preparation never executes the user command. */ }
		throw sandboxFailure(code, "Remote sandbox preparation failed. The command was not executed.");
	}

	async #capture(target: SshTargetSnapshot, signal: AbortSignal, command: string) {
		let stdout = "";
		const decoder = new StringDecoder("utf8");
		const result = await this.#broker.execute({ target, signal, command,
			onStdout: async (chunk) => {
				stdout += decoder.write(Buffer.from(chunk));
				if (stdout.length > 16_384) throw sandboxFailure("sandbox_probe_failed", "Sandbox probe output exceeded its limit. The command was not executed.");
			}, onStderr: async () => {} });
		return { ...result, stdout: stdout + decoder.end() };
	}
}

function sandboxArgs(path: string, root: string): string[] {
	return [path, "--new-session",
		"--ro-bind", "/", "/", "--bind", root, root, "--bind", "/tmp", "/tmp",
		"--tmpfs", "/dev", "--dev-bind", "/dev/null", "/dev/null", "--ro-bind", "/proc", "/proc"];
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`);
}
