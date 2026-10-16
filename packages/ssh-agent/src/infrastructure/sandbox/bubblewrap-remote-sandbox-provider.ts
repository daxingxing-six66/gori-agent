import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { PreparedRemoteTerminal, PreparedSandboxedExecution, RemoteSandboxBackend } from "../../application/services/remote-sandbox-provider.ts";
import type { RemoteCommandBroker, SshConnectionPoolControl } from "../../application/ssh-channel-broker.ts";
import { canonicalRemoteSandboxRoot, sandboxFailure } from "../../domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { isWithinSandboxRoot, RemoteSandboxRules, requireProtectedExecutable } from "./remote-sandbox-rules.ts";
import { SandboxCapabilityCache } from "./sandbox-capability-cache.ts";
import { SandboxCommandRunner, sandboxCommandFailure } from "./sandbox-command-runner.ts";
import { quoteShell, shellArgv, wrapRemoteCommand } from "./shell-command.ts";

type Broker = RemoteCommandBroker & Partial<Pick<SshConnectionPoolControl, "snapshotWorkspace">>;
interface Runner { path: string; version: string; }
interface Rules { runner: Runner; sandboxRoots: string[]; }
interface HostNamespaces { pid: string; network: string; }
interface ProbeFiles { outside: string; writable: string[]; }

/** Uses an installed, unprivileged Bubblewrap. No package operation occurs here. */
export class BubblewrapRemoteSandboxProvider implements RemoteSandboxBackend {
	readonly #commands: SandboxCommandRunner;
	readonly #rules: RemoteSandboxRules;
	readonly #runners: SandboxCapabilityCache<Runner>;

	constructor(options: { broker: Broker }) {
		this.#commands = new SandboxCommandRunner(options.broker);
		this.#rules = new RemoteSandboxRules(this.#commands);
		this.#runners = new SandboxCapabilityCache(options.broker, (target, signal) => this.#discover(target, signal));
	}

	async getCapabilities(target: SshTargetSnapshot, signal: AbortSignal): Promise<PreparedSandboxedExecution["sandbox"]> {
		return sandboxFacts(await this.#prepareRules(target, signal));
	}

	async refreshCapabilities(target: SshTargetSnapshot, inputSignal: AbortSignal): Promise<PreparedSandboxedExecution["sandbox"]> {
		const signal = preparationSignal(inputSignal);
		await this.#runners.refresh(target, signal);
		return this.getCapabilities(target, signal);
	}

	async prepare(input: Parameters<RemoteSandboxBackend["prepare"]>[0]): Promise<PreparedSandboxedExecution> {
		const rules = await this.#prepareRules(input.target, input.signal);
		const marker = `gori-bubblewrap: confined version=${rules.runner.version} token=${randomBytes(16).toString("hex")}\n`;
		const script = `printf %s ${quoteShell(marker)} >&2; ${wrapRemoteCommand(input.cwd, input.command)}`;
		return {
			command: shellArgv([...sandboxArgs(rules.runner.path, rules.sandboxRoots), "--", "/bin/bash", "--noprofile", "--norc", "-c", script]),
			sandbox: sandboxFacts(rules), confirmation: marker,
		};
	}

	async prepareTerminal(input: Parameters<RemoteSandboxBackend["prepareTerminal"]>[0]): Promise<PreparedRemoteTerminal> {
		const rules = await this.#prepareRules(input.target, input.signal);
		const marker = `gori-bubblewrap: confined version=${rules.runner.version} token=${randomBytes(16).toString("hex")}`;
		const script = `printf '%s\\n' ${quoteShell(marker)} >&2; exec /bin/bash --login -i`;
		return {
			command: `exec ${shellArgv([...sandboxArgs(rules.runner.path, rules.sandboxRoots), "--", "/bin/bash", "--noprofile", "--norc", "-c", script])}`,
			sandbox: sandboxFacts(rules), confirmation: marker,
		};
	}

	async #prepareRules(target: SshTargetSnapshot, inputSignal: AbortSignal): Promise<Rules> {
		const signal = preparationSignal(inputSignal);
		// Availability comes first, retaining the distinct missing-installation verdict.
		const runner = await this.#runners.get(target, signal);
		const sandboxRoots = await this.#rules.writableRoots(target, signal);
		await this.#rules.requireRuntimePaths(target, signal);
		requireProtectedExecutable(runner.path, sandboxRoots, "the Bubblewrap executable");
		await this.#verifyConfinement(target, signal, runner, sandboxRoots);
		return { runner, sandboxRoots };
	}

	async #verifyConfinement(target: SshTargetSnapshot, signal: AbortSignal, runner: Runner, roots: string[]): Promise<void> {
		const namespaces = await this.#hostNamespaces(target, signal);
		const files = await this.#createProbeFiles(target, signal, roots);
		try {
			const probe = await this.#commands.capture({ target, signal, stage: "Bubblewrap confinement",
				command: confinementProbeCommand(runner.path, roots, namespaces, files) });
			if (probe.exitCode !== 0 || probe.exitSignal || probe.stdout !== "gori-bubblewrap-probe")
				throw sandboxCommandFailure({ stage: "Bubblewrap confinement (host PID/network access and filesystem writes)", code: "sandbox_unavailable" }, probe);
		} finally {
			await this.#commands.capture({ target, signal: AbortSignal.timeout(1_000), stage: "Bubblewrap probe cleanup",
				command: `rm -f -- ${quoteShell(files.outside)} ${shellArgv(files.writable)}` }).catch(() => {});
		}
	}

	async #hostNamespaces(target: SshTargetSnapshot, signal: AbortSignal): Promise<HostNamespaces> {
		const [pid, network] = (await this.#commands.checked({ target, signal, stage: "host PID/network namespaces",
			command: "readlink /proc/self/ns/pid && readlink /proc/self/ns/net" })).trimEnd().split("\n");
		if (!/^pid:\[\d+\]$/.test(pid ?? "") || !/^net:\[\d+\]$/.test(network ?? "")) throw sandboxFailure("sandbox_probe_failed",
			"Remote host process and network namespaces could not be verified. The command was not executed.");
		return { pid, network };
	}

	async #createProbeFiles(target: SshTargetSnapshot, signal: AbortSignal, roots: string[]): Promise<ProbeFiles> {
		const candidates = await this.#commands.checked({ target, signal, stage: "outside writable probe directory",
			command: 'for candidate in /var/tmp "$HOME" "/run/user/$(id -u)"; do if test -d "$candidate" && test -w "$candidate"; then realpath -e -- "$candidate"; fi; done' });
		const outside = candidates.replace(/\n$/, "").split("\n").find((candidate) =>
			canonicalRemoteSandboxRoot(candidate) && !roots.some((root) => isWithinSandboxRoot(candidate, root)) && !isWithinSandboxRoot(candidate, "/tmp"));
		if (!outside) throw sandboxFailure("sandbox_probe_failed",
			"No host-writable path outside the sandbox roots was available to verify Bubblewrap confinement. The command was not executed.");
		const files = { outside: posix.join(outside, `.gori-bwrap-probe-${randomBytes(16).toString("hex")}`),
			writable: roots.map((root) => posix.join(root, `.gori-bwrap-write-probe-${randomBytes(16).toString("hex")}`)) };
		await this.#commands.checked({ target, signal, stage: "outside writable probe file",
			command: `umask 077 && (set -C; : > ${quoteShell(files.outside)})` });
		return files;
	}

	async #discover(target: SshTargetSnapshot, signal: AbortSignal): Promise<Runner> {
		const platform = (await this.#commands.checked({ target, signal, stage: "Bubblewrap platform", command: "uname -s" })).trim();
		if (platform !== "Linux") throw sandboxFailure("sandbox_unsupported_platform", "Remote sandbox requires Linux. The command was not executed.");
		const inspect = await this.#commands.checked({ target, signal, stage: "Bubblewrap executable ownership and version",
			command: 'p=$(command -v bwrap) || { printf "missing\\n"; exit 0; }; p=$(realpath -e -- "$p") || exit 2; printf "path=%s\\n" "$p"; q="$p"; while :; do stat -Lc "stat=%u:%a" -- "$q" || exit 2; [ "$q" = / ] && break; q=$(dirname -- "$q"); done; "$p" --version' });
		return requireBubblewrapRunner(inspect);
	}
}

function preparationSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
}

function requireBubblewrapRunner(inspect: string): Runner {
	if (inspect === "missing\n") throw sandboxFailure("sandbox_bubblewrap_not_installed",
		"Landlock is unavailable and Bubblewrap is not installed. Installation requires your approval. The command was not executed.");
	const lines = inspect.trimEnd().split("\n");
	const pathLine = lines.shift();
	const path = pathLine?.startsWith("path=") ? pathLine.slice(5) : undefined;
	const versionLine = lines.pop();
	if (!path || !canonicalRemoteSandboxRoot(path) || path.includes("\r") ||
		!versionLine || !/^bubblewrap \d+\.\d+\.\d+$/.test(versionLine) || lines.length === 0 || !lines.every(protectedFileMode))
		throw sandboxFailure("sandbox_probe_failed", "Bubblewrap must be a root-owned, non-setuid executable under root-owned, non-writable directories. The command was not executed.");
	const version = versionLine.slice("bubblewrap ".length);
	const [major, minor, patch] = version.split(".").map(Number);
	if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch) ||
		major < 0 || (major === 0 && minor < 12)) throw sandboxFailure("sandbox_partial_enforcement",
		"Bubblewrap 0.12.0 or later is required. The command was not executed.");
	return { path, version };
}

function protectedFileMode(line: string): boolean {
	const match = /^stat=(\d+):([0-7]{3,4})$/.exec(line);
	return match !== null && match[1] === "0" && (Number.parseInt(match[2], 8) & 0o4022) === 0;
}

function confinementProbeCommand(path: string, roots: string[], namespaces: HostNamespaces, files: ProbeFiles): string {
	const checks = [
		`test "$(readlink /proc/self/ns/pid)" = ${quoteShell(namespaces.pid)}`,
		`test "$(readlink /proc/self/ns/net)" = ${quoteShell(namespaces.network)}`,
		'test -n "$GORI_HOST_PROBE_PID" && test -r "/proc/$GORI_HOST_PROBE_PID/stat" && kill -0 "$GORI_HOST_PROBE_PID"',
		`test -w /tmp && test -c /dev/null && test -e ${quoteShell(files.outside)}`,
		...files.writable.map((file) => `(set -C; : > ${quoteShell(file)}) && rm -f -- ${quoteShell(file)}`),
		"(: > /dev/null)",
		`{ if (: >> ${quoteShell(files.outside)}) 2>/dev/null; then exit 2; fi; printf gori-bubblewrap-probe; }`,
	];
	const script = `umask 077; ${checks.join(" && ")}`;
	return `GORI_HOST_PROBE_PID=$$ ${shellArgv([...sandboxArgs(path, roots), "--", "/bin/bash", "--noprofile", "--norc", "-c", script])}; exit $?`;
}

function sandboxFacts({ runner, sandboxRoots }: Rules): PreparedRemoteTerminal["sandbox"] & { backend: "bubblewrap" } {
	return { mode: "workspace_write", backend: "bubblewrap", enforcement: "full", bubblewrapVersion: runner.version, sandboxRoot: sandboxRoots[0], sandboxRoots };
}

function sandboxArgs(path: string, roots: readonly string[]): string[] {
	// Parent mounts precede nested mounts so every selected directory keeps its writable binding.
	const mounts = [...roots].sort((a, b) => a.split("/").length - b.split("/").length);
	return [path, "--new-session", "--ro-bind", "/", "/", ...mounts.flatMap((root) => ["--bind", root, root]), "--bind", "/tmp", "/tmp",
		"--tmpfs", "/dev", "--dev-bind", "/dev/null", "/dev/null", "--ro-bind", "/proc", "/proc"];
}
