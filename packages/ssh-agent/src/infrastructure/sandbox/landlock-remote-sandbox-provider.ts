import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { PreparedRemoteTerminal, PreparedSandboxedExecution, RemoteSandboxBackend } from "../../application/services/remote-sandbox-provider.ts";
import type { RemoteCommandBroker, SftpFileBroker, SshConnectionPoolControl } from "../../application/ssh-channel-broker.ts";
import { GORI_LANDLOCK_LAUNCHER_VERSION, GORI_MIN_LANDLOCK_ABI, sandboxFailure } from "../../domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { RemoteSandboxRules, requireProtectedExecutable, requireSandboxRoot } from "./remote-sandbox-rules.ts";
import { SandboxCapabilityCache } from "./sandbox-capability-cache.ts";
import { SandboxCommandRunner, sandboxPreparationFailure } from "./sandbox-command-runner.ts";
import { quoteShell, shellArgv, wrapRemoteCommand } from "./shell-command.ts";

type Broker = RemoteCommandBroker & Pick<SftpFileBroker, "upload" | "deleteFile"> & Partial<Pick<SshConnectionPoolControl, "snapshotWorkspace">>;
interface Launcher { path: string; abi: number; }
interface Rules { launcher: Launcher; sandboxRoot: string; }

export class LandlockRemoteSandboxProvider implements RemoteSandboxBackend {
	readonly #broker: Broker;
	readonly #loadBinary: (architecture: "x64" | "arm64") => Promise<Uint8Array>;
	readonly #commands: SandboxCommandRunner;
	readonly #rules: RemoteSandboxRules;
	readonly #launchers: SandboxCapabilityCache<Launcher>;

	constructor(options: { broker: Broker; loadBinary?: (architecture: "x64" | "arm64") => Promise<Uint8Array> }) {
		this.#broker = options.broker;
		this.#loadBinary = options.loadBinary ?? (async (architecture) =>
			readFile(new URL(`../../../resources/sandbox/linux-${architecture}/gori-landlock-run`, import.meta.url)));
		this.#commands = new SandboxCommandRunner(options.broker);
		this.#rules = new RemoteSandboxRules(this.#commands);
		this.#launchers = new SandboxCapabilityCache(options.broker, (target, signal) => this.#deploy(target, signal));
	}

	async getCapabilities(target: SshTargetSnapshot, signal: AbortSignal): Promise<PreparedSandboxedExecution["sandbox"]> {
		return sandboxFacts(await this.#prepareRules(target, signal));
	}

	async refreshCapabilities(target: SshTargetSnapshot, inputSignal: AbortSignal): Promise<PreparedSandboxedExecution["sandbox"]> {
		const signal = preparationSignal(inputSignal);
		signal.throwIfAborted();
		requireSandboxRoot(target.defaultCwd);
		await this.#launchers.refresh(target, signal);
		return this.getCapabilities(target, signal);
	}

	async prepare(input: Parameters<RemoteSandboxBackend["prepare"]>[0]): Promise<PreparedSandboxedExecution> {
		const rules = await this.#prepareRules(input.target, input.signal);
		const token = randomBytes(16).toString("hex");
		return {
			command: shellArgv([...launcherArgs(rules, token), "--", "/bin/bash", "--noprofile", "--norc", "-c", wrapRemoteCommand(input.cwd, input.command)]),
			sandbox: sandboxFacts(rules),
			confirmation: `gori-landlock: confined abi=${rules.launcher.abi} token=${token}\n`,
		};
	}

	async prepareTerminal(input: Parameters<RemoteSandboxBackend["prepareTerminal"]>[0]): Promise<PreparedRemoteTerminal> {
		// Preserve the unsupported-kernel/architecture verdict even without a configured writable root.
		await this.#launchers.get(input.target, preparationSignal(input.signal));
		const rules = await this.#prepareRules(input.target, input.signal);
		const token = randomBytes(16).toString("hex");
		return {
			command: `cd -- ${quoteShell(rules.sandboxRoot)} && exec ${shellArgv([...launcherArgs(rules, token), "--", "--terminal"])}`,
			sandbox: sandboxFacts(rules),
			confirmation: `gori-landlock: confined abi=${rules.launcher.abi} token=${token}`,
		};
	}

	async #prepareRules(target: SshTargetSnapshot, inputSignal: AbortSignal): Promise<Rules> {
		const signal = preparationSignal(inputSignal);
		const sandboxRoot = await this.#rules.writableRoot(target, signal);
		const launcher = await this.#launchers.get(target, signal);
		await this.#rules.requireRuntimePaths(target, signal);
		requireProtectedExecutable(launcher.path, sandboxRoot, "the Gori launcher cache");
		return { launcher, sandboxRoot };
	}

	async #deploy(target: SshTargetSnapshot, signal: AbortSignal): Promise<Launcher> {
		const { architecture, home } = await this.#remotePlatform(target, signal);
		let binary: Uint8Array;
		try { binary = await this.#loadBinary(architecture); }
		catch (error) { throw sandboxPreparationFailure("sandbox_launcher_missing", "bundled Landlock launcher", error); }
		const path = await this.#installLauncher(target, signal, home, binary);
		const probe = await this.#commands.checked({ target, signal, command: shellArgv([path, "--probe"]), stage: "Landlock kernel capability" });
		return { path, abi: requireLandlockAbi(probe) };
	}

	async #remotePlatform(target: SshTargetSnapshot, signal: AbortSignal): Promise<{ architecture: "x64" | "arm64"; home: string }> {
		const platform = await this.#commands.checked({ target, signal, stage: "Landlock platform",
			command: 'uname -s && uname -m && printf "%s\\n" "$HOME"' });
		const [os, arch, home, ...extra] = platform.replace(/\n$/, "").split("\n");
		if (os !== "Linux") throw sandboxFailure("sandbox_unsupported_platform", "Remote sandbox requires Linux. The command was not executed.");
		const architecture = arch === "x86_64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : undefined;
		if (!architecture) throw sandboxFailure("sandbox_unsupported_architecture", "Remote sandbox supports only Linux x64 and arm64. The command was not executed.");
		if (!home?.startsWith("/") || home.includes("\0") || extra.length) throw sandboxFailure("sandbox_prepare_failed", "Remote home directory is invalid. The command was not executed.");
		return { architecture, home };
	}

	async #installLauncher(target: SshTargetSnapshot, signal: AbortSignal, home: string, binary: Uint8Array): Promise<string> {
		const digest = createHash("sha256").update(binary).digest("hex");
		const requestedDirectory = posix.join(home, ".cache/gori/sandbox", GORI_LANDLOCK_LAUNCHER_VERSION, digest);
		const directory = (await this.#commands.checked({ target, signal, stage: "launcher cache directory", code: "sandbox_launcher_upload_failed",
			command: `umask 077 && mkdir -p -- ${quoteShell(requestedDirectory)} && cd -- ${quoteShell(requestedDirectory)} && pwd -P` })).replace(/\n$/, "");
		if (!directory.startsWith("/") || directory.includes("\n") || directory.includes("\0")) throw sandboxFailure("sandbox_prepare_failed", "Invalid launcher directory. The command was not executed.");
		const path = posix.join(directory, "gori-landlock-run");
		const existing = await this.#commands.capture({ target, signal, stage: "launcher digest", command: `sha256sum -- ${quoteShell(path)}` });
		if (existing.exitCode !== 0 || existing.exitSignal || existing.stdout.split(/\s/)[0] !== digest)
			await this.#uploadLauncher(target, signal, directory, path, binary);
		return path;
	}

	async #uploadLauncher(target: SshTargetSnapshot, signal: AbortSignal, directory: string, path: string, binary: Uint8Array): Promise<void> {
		const temporaryPath = posix.join(directory, `.gori-landlock-run.uploading-${randomUUID()}`);
		try {
			await this.#broker.upload({ target, remotePath: temporaryPath, signal, overwrite: false,
				data: (async function* () { yield binary; })(), onProgress: async () => {} });
			await this.#commands.checked({ target, signal, stage: "launcher atomic install", code: "sandbox_launcher_upload_failed",
				command: `chmod 0700 -- ${quoteShell(temporaryPath)} && mv -fT -- ${quoteShell(temporaryPath)} ${quoteShell(path)}` });
		} catch (error) {
			signal.throwIfAborted();
			throw sandboxPreparationFailure("sandbox_launcher_upload_failed", "launcher upload", error);
		} finally {
			await this.#broker.deleteFile({ target, remotePath: temporaryPath, signal: AbortSignal.timeout(1_000) }).catch(() => {});
		}
	}
}

function preparationSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
}

function requireLandlockAbi(probe: string): number {
	if (/^gori-landlock: unavailable\n?$/.test(probe))
		throw sandboxFailure("sandbox_unavailable", "Remote Landlock is unavailable. The command was not executed.");
	const match = /^gori-landlock: abi=([1-9]\d*) enforcement=(full|partial)\n?$/.exec(probe);
	if (!match) throw sandboxFailure("sandbox_probe_failed", "Remote Landlock kernel capability check returned an invalid result. The command was not executed.");
	const abi = Number(match[1]);
	if (!Number.isSafeInteger(abi) || abi < GORI_MIN_LANDLOCK_ABI || match[2] !== "full") throw sandboxFailure("sandbox_partial_enforcement",
		`Remote Landlock requires ABI >= ${GORI_MIN_LANDLOCK_ABI}. The command was not executed.`);
	return abi;
}

function sandboxFacts({ launcher, sandboxRoot }: Rules): PreparedRemoteTerminal["sandbox"] & { backend: "landlock" } {
	return { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: launcher.abi,
		launcherVersion: GORI_LANDLOCK_LAUNCHER_VERSION, sandboxRoot };
}

function launcherArgs({ launcher, sandboxRoot }: Rules, token: string): string[] {
	return [launcher.path, "--confirm-token", token, "--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", sandboxRoot];
}
