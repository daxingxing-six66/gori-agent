import type {
	PreparedRemoteExecution,
	PreparedRemoteTerminal,
	PreparedSandboxedExecution,
	RemoteSandboxBackend,
	RemoteSandboxProvider,
} from "../../application/services/remote-sandbox-provider.ts";
import { isSandboxBackendUnavailable, isTerminalSandboxFallbackEligible } from "../../domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { wrapRemoteCommand } from "./shell-command.ts";

/** Selects a constrained backend; an operational failure never silently removes confinement. */
export class RemoteSandboxCoordinator implements RemoteSandboxProvider {
	readonly #backends: readonly RemoteSandboxBackend[];

	constructor(backends: readonly RemoteSandboxBackend[]) {
		if (backends.length === 0) throw new Error("At least one remote sandbox backend must be configured");
		this.#backends = [...backends];
	}

	probe(target: SshTargetSnapshot, signal: AbortSignal): Promise<PreparedSandboxedExecution["sandbox"]> {
		return this.#firstAvailable((backend) => backend.probe(target, signal), signal);
	}

	prepare(input: Parameters<RemoteSandboxProvider["prepare"]>[0]): Promise<PreparedRemoteExecution> {
		if (input.policy.mode === "full_access") {
			input.signal.throwIfAborted();
			return Promise.resolve({
				command: wrapRemoteCommand(input.cwd, input.command),
				sandbox: { mode: "full_access", backend: "none", enforcement: "none" },
			});
		}
		return this.#firstAvailable((backend) => backend.prepare(input), input.signal);
	}

	prepareTerminal(input: Parameters<RemoteSandboxProvider["prepareTerminal"]>[0]): Promise<PreparedRemoteTerminal> {
		return this.#firstAvailable((backend) => backend.prepareTerminal(input), input.signal, true);
	}

	async #firstAvailable<T>(attempt: (backend: RemoteSandboxBackend) => Promise<T>, signal: AbortSignal, terminal = false): Promise<T> {
		let unavailable: unknown;
		let fallbackIneligible: unknown;
		for (const backend of this.#backends) {
			signal.throwIfAborted();
			try {
				return await attempt(backend);
			} catch (error) {
				if (!isSandboxBackendUnavailable(error)) throw error;
				unavailable = error;
				if (terminal && !isTerminalSandboxFallbackEligible(error)) fallbackIneligible ??= error;
			}
		}
		signal.throwIfAborted();
		throw fallbackIneligible ?? unavailable;
	}
}
