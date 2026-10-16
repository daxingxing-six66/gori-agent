import { canonicalRemoteSandboxRoot, sandboxFailure, validRemoteSandboxRoot } from "../../domain/remote-sandbox.ts";
import { MAX_SANDBOX_WRITABLE_ROOTS } from "../../domain/sandbox-writable-roots.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { SandboxCommandRunner } from "./sandbox-command-runner.ts";
import { quoteShell } from "./shell-command.ts";

export function requireSandboxRoots(target: SshTargetSnapshot): readonly string[] {
	const roots = target.sandboxWritableRoots ?? [];
	if (target.sandboxReadOnly === true) return ["/tmp"];
	if (roots.length === 0 || roots.length > MAX_SANDBOX_WRITABLE_ROOTS || !roots.every(validRemoteSandboxRoot)) {
		throw sandboxFailure("sandbox_root_invalid", "Configure 1 to 16 remote writable directories other than / before using workspace_write. The command was not executed.");
	}
	return roots;
}

/** Policy prerequisites are rechecked for every preparation, independently of backend metadata. */
export class RemoteSandboxRules {
	readonly #commands: SandboxCommandRunner;
	constructor(commands: SandboxCommandRunner) { this.#commands = commands; }

	async writableRoots(target: SshTargetSnapshot, signal: AbortSignal): Promise<string[]> {
		const roots: string[] = [];
		for (const root of requireSandboxRoots(target)) {
			const canonical = (await this.#commands.checked({ target, signal, stage: "writable root", code: "sandbox_root_unavailable",
				command: `test -d ${quoteShell(root)} && test -r ${quoteShell(root)} && test -x ${quoteShell(root)} && realpath -e -- ${quoteShell(root)}` })).replace(/\n$/, "");
			if (!canonicalRemoteSandboxRoot(canonical)) throw sandboxFailure("sandbox_root_invalid",
				"Remote sandbox root could not be safely canonicalized. The command was not executed.");
			if (!roots.includes(canonical)) roots.push(canonical);
		}
		return roots;
	}

	async requireRuntimePaths(target: SshTargetSnapshot, signal: AbortSignal): Promise<void> {
		const temporaryRoot = (await this.#commands.checked({ target, signal, stage: "temporary directory", code: "sandbox_prepare_failed",
			command: "test -d /tmp && realpath -e -- /tmp" })).replace(/\n$/, "");
		if (temporaryRoot !== "/tmp") throw sandboxFailure("sandbox_prepare_failed",
			"Remote temporary directory is unsafe: realpath /tmp must be /tmp. The command was not executed.");
		await this.#commands.checked({ target, signal, stage: "null device", code: "sandbox_prepare_failed",
			command: 'test -c /dev/null && test "$(stat -Lc "%t:%T" -- /dev/null)" = "1:3"' });
	}
}

export function requireProtectedExecutable(path: string, roots: readonly string[], name: string): void {
	if (roots.some((root) => isWithinSandboxRoot(path, root)) || isWithinSandboxRoot(path, "/tmp")) throw sandboxFailure("sandbox_root_invalid",
		`The sandbox root must not contain ${name}. Use a dedicated application directory. The command was not executed.`);
}

export function isWithinSandboxRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`);
}
