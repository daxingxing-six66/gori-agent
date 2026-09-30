import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { PreparedRemoteExecution, RemoteSandboxProvider } from "../../application/services/remote-sandbox-provider.ts";
import type { RemoteCommandBroker, SftpFileBroker, SshConnectionPoolControl } from "../../application/ssh-channel-broker.ts";
import { GORI_LANDLOCK_LAUNCHER_VERSION, GORI_MIN_LANDLOCK_ABI, sandboxFailure, validRemoteSandboxRoot } from "../../domain/remote-sandbox.ts";
import type { SshFailureCode } from "../../domain/ssh-failure.ts";
import { connectionKeyFor, serializeConnectionKey, type SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { quoteShell, shellArgv, wrapRemoteCommand } from "./shell-command.ts";

type Broker = RemoteCommandBroker & Pick<SftpFileBroker, "upload" | "deleteFile"> & Partial<Pick<SshConnectionPoolControl, "snapshotWorkspace">>;
interface Launcher { path: string; abi: number; }

export class LandlockRemoteSandboxProvider implements RemoteSandboxProvider {
	readonly #broker: Broker;
	readonly #loadBinary: (architecture: "x64" | "arm64") => Promise<Uint8Array>;
	readonly #capabilities = new Map<string, { generation: number; launcher: Launcher }>();
	readonly #preparing = new Map<string, Promise<Launcher>>();

	constructor(options: { broker: Broker; loadBinary?: (architecture: "x64" | "arm64") => Promise<Uint8Array> }) {
		this.#broker = options.broker;
		this.#loadBinary = options.loadBinary ?? (async (architecture) =>
			readFile(new URL(`../../../resources/sandbox/linux-${architecture}/gori-landlock-run`, import.meta.url)));
	}

	/** Explicit UI probe discards the cached verdict, without running a user command. */
	async probe(target: SshTargetSnapshot, signal: AbortSignal): Promise<PreparedRemoteExecution["sandbox"]> {
		const key = serializeConnectionKey(connectionKeyFor(target));
		// An in-flight prepare may populate the cache after deletion. Wait for it, then force a new probe.
		await this.#preparing.get(key)?.catch(() => {});
		signal.throwIfAborted();
		this.#capabilities.delete(key);
		const prepared = await this.prepare({ target, signal, cwd: "/", command: "true",
			policy: { mode: "workspace_write", sandboxRoot: target.remoteSandboxRoot } });
		return prepared.sandbox;
	}

	async prepare(input: Parameters<RemoteSandboxProvider["prepare"]>[0]): Promise<PreparedRemoteExecution> {
		if (input.policy.mode === "full_access") {
			return { command: wrapRemoteCommand(input.cwd, input.command), sandbox: { mode: "full_access", backend: "none", enforcement: "none" } };
		}
		const root = input.policy.sandboxRoot;
		if (!root || !validRemoteSandboxRoot(root)) {
			throw sandboxFailure("sandbox_root_invalid", "Configure an absolute remoteSandboxRoot other than / before using workspace_write. The command was not executed.");
		}
		const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
		const canonical = await this.checked(input.target, signal,
			`test -d ${quoteShell(root)} && test -r ${quoteShell(root)} && test -x ${quoteShell(root)} && realpath -e -- ${quoteShell(root)}`,
			"sandbox_root_unavailable");
		const sandboxRoot = canonical.replace(/\n$/, "");
		if (!validRemoteSandboxRoot(sandboxRoot) || sandboxRoot.includes("\n")) {
			throw sandboxFailure("sandbox_root_invalid", "Remote sandbox root could not be safely canonicalized. The command was not executed.");
		}
		const launcher = await this.ensureLauncher(input.target, signal);
		const temporaryRoot = (await this.checked(input.target, signal,
			"test -d /tmp && realpath -e -- /tmp", "sandbox_prepare_failed")).replace(/\n$/, "");
		if (!validRemoteSandboxRoot(temporaryRoot) || temporaryRoot.includes("\n")) {
			throw sandboxFailure("sandbox_prepare_failed", "Remote temporary directory is unsafe. The command was not executed.");
		}
		await this.checked(input.target, signal, 'test -c /dev/null && test "$(stat -Lc "%t:%T" -- /dev/null)" = "1:3"', "sandbox_prepare_failed");
		// A confined command must not be able to replace the launcher used by later calls.
		if (isWithin(launcher.path, sandboxRoot) || isWithin(launcher.path, temporaryRoot)) {
			throw sandboxFailure("sandbox_root_invalid", "The sandbox root must not contain the Gori launcher cache. Use a dedicated application directory. The command was not executed.");
		}
		return {
			command: shellArgv([launcher.path, "--ro", "/", "--rw", "/dev/null", "--rw", temporaryRoot, "--rw", sandboxRoot,
				"--", "/bin/bash", "--noprofile", "--norc", "-c", wrapRemoteCommand(input.cwd, input.command)]),
			sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: launcher.abi,
				launcherVersion: GORI_LANDLOCK_LAUNCHER_VERSION, sandboxRoot },
			confirmation: `gori-landlock: confined abi=${launcher.abi}\n`,
		};
	}

	private async ensureLauncher(target: SshTargetSnapshot, signal: AbortSignal): Promise<Launcher> {
		const key = serializeConnectionKey(connectionKeyFor(target));
		const generation = this.#broker.snapshotWorkspace?.(target.workspaceId).generation ?? 0;
		const cached = this.#capabilities.get(key);
		if (cached?.generation === generation) return cached.launcher;
		const pending = this.#preparing.get(key);
		if (pending) {
			await pending;
			signal.throwIfAborted();
			return this.ensureLauncher(target, signal);
		}
		const preparation = this.deploy(target, signal);
		this.#preparing.set(key, preparation);
		try {
			const launcher = await preparation;
			this.#capabilities.set(key, { launcher, generation: this.#broker.snapshotWorkspace?.(target.workspaceId).generation ?? 0 });
			return launcher;
		} finally {
			this.#preparing.delete(key);
		}
	}

	private async deploy(target: SshTargetSnapshot, signal: AbortSignal): Promise<Launcher> {
		const platform = await this.checked(target, signal, 'uname -s && uname -m && printf "%s\\n" "$HOME"', "sandbox_probe_failed");
		const [os, arch, home, ...extra] = platform.replace(/\n$/, "").split("\n");
		if (os !== "Linux") throw sandboxFailure("sandbox_unsupported_platform", "Remote sandbox requires Linux. The command was not executed.");
		const architecture = arch === "x86_64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : undefined;
		if (!architecture) throw sandboxFailure("sandbox_unsupported_architecture", "Remote sandbox supports only Linux x64 and arm64. The command was not executed.");
		if (!home?.startsWith("/") || home.includes("\0") || extra.length) throw sandboxFailure("sandbox_prepare_failed", "Remote home directory is invalid. The command was not executed.");
		let binary: Uint8Array;
		try { binary = await this.#loadBinary(architecture); }
		catch { throw sandboxFailure("sandbox_launcher_missing", "The bundled Linux sandbox launcher is missing. The command was not executed."); }
		const digest = createHash("sha256").update(binary).digest("hex");
		const requestedDirectory = posix.join(home, ".cache/gori/sandbox", GORI_LANDLOCK_LAUNCHER_VERSION, digest);
		const directory = (await this.checked(target, signal,
			`umask 077 && mkdir -p -- ${quoteShell(requestedDirectory)} && cd -- ${quoteShell(requestedDirectory)} && pwd -P`,
			"sandbox_launcher_upload_failed")).replace(/\n$/, "");
		if (!directory.startsWith("/") || directory.includes("\n") || directory.includes("\0")) throw sandboxFailure("sandbox_prepare_failed", "Invalid launcher directory. The command was not executed.");
		const path = posix.join(directory, "gori-landlock-run");
		const existing = await this.capture(target, signal, `sha256sum -- ${quoteShell(path)}`);
		if (existing.exitCode !== 0 || existing.stdout.split(/\s/)[0] !== digest) {
			const temporaryPath = posix.join(directory, `.gori-landlock-run.uploading-${randomUUID()}`);
			try {
				await this.#broker.upload({ target, remotePath: temporaryPath, signal, overwrite: false,
					data: (async function* () { yield binary; })(), onProgress: async () => {} });
				await this.checked(target, signal,
					`chmod 0700 -- ${quoteShell(temporaryPath)} && mv -fT -- ${quoteShell(temporaryPath)} ${quoteShell(path)}`,
					"sandbox_launcher_upload_failed");
			} catch {
				throw sandboxFailure("sandbox_launcher_upload_failed", "Remote sandbox launcher deployment failed. The command was not executed.");
			} finally {
				await this.#broker.deleteFile({ target, remotePath: temporaryPath, signal: AbortSignal.timeout(1_000) }).catch(() => {});
			}
		}
		const probe = await this.checked(target, signal, shellArgv([path, "--probe"]), "sandbox_probe_failed");
		const match = /^gori-landlock: abi=([1-9]\d*) enforcement=(full|partial)\n?$/.exec(probe);
		if (!match) throw sandboxFailure("sandbox_probe_failed", "Remote sandbox probe returned an invalid result. The command was not executed.");
		const abi = Number(match[1]);
		if (abi < GORI_MIN_LANDLOCK_ABI || match[2] !== "full") throw sandboxFailure("sandbox_partial_enforcement", `Remote Landlock requires ABI >= ${GORI_MIN_LANDLOCK_ABI}. The command was not executed.`);
		return { path, abi };
	}

	private async checked(target: SshTargetSnapshot, signal: AbortSignal, command: string, code: SshFailureCode): Promise<string> {
		try {
			const result = await this.capture(target, signal, command);
			if (result.exitCode === 0 && !result.exitSignal) return result.stdout;
		} catch { /* Preparation never executes the user command. */ }
		throw sandboxFailure(code, "Remote sandbox preparation failed. The command was not executed.");
	}

	private async capture(target: SshTargetSnapshot, signal: AbortSignal, command: string) {
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

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`);
}
