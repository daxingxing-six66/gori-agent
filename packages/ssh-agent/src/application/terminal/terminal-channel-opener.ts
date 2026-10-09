import type { TerminalSandboxFacts } from "../../domain/terminal.ts";
import { TerminalError } from "../../domain/terminal.ts";
import type { RemoteSandboxProvider } from "../services/remote-sandbox-provider.ts";
import type { SshTargetResolver } from "../services/ssh-target-resolver.ts";
import type { TerminalChannelBroker, TerminalChannelHandle } from "../ssh-channel-broker.ts";
import type { TerminalSessionActor } from "./terminal-session-actor.ts";

interface OpenedTerminalChannel {
	readonly channel: TerminalChannelHandle;
	readonly sandbox: TerminalSandboxFacts;
}

/** Opens a sandboxed channel within one deadline; the Actor owns activation and session state. */
export class TerminalChannelOpener {
	readonly #targets: SshTargetResolver;
	readonly #sandbox: RemoteSandboxProvider;
	readonly #broker: TerminalChannelBroker;
	readonly #timeoutMs: number;

	constructor(options: {
		targets: SshTargetResolver;
		sandbox: RemoteSandboxProvider;
		broker: TerminalChannelBroker;
		timeoutMs: number;
	}) {
		this.#targets = options.targets;
		this.#sandbox = options.sandbox;
		this.#broker = options.broker;
		this.#timeoutMs = options.timeoutMs;
	}

	async open(actor: TerminalSessionActor, controller: AbortController): Promise<OpenedTerminalChannel> {
		const timeoutError = new TerminalError("terminal_open_timeout", "Timed out opening the SSH terminal channel", {
			status: 504, retryable: true,
		});
		const interruptionFailure = (): TerminalError =>
			controller.signal.reason === timeoutError ? timeoutError : openingCancelled();
		let rejectInterrupted: (error: unknown) => void = () => undefined;
		const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
		const abort = (): void => {
			rejectInterrupted(interruptionFailure());
		};
		controller.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => controller.abort(timeoutError), this.#timeoutMs);
		timer.unref();
		if (controller.signal.aborted) abort();
		const pending = Promise.resolve().then(async () => {
			const opened = await this.#connect(actor, controller.signal);
			// A Broker may resolve after cancellation; dispose before returning ownership to the Actor.
			if (controller.signal.aborted) {
				opened.channel.dispose();
				throw interruptionFailure();
			}
			return opened;
		});
		try {
			const opened = await Promise.race([pending, interrupted]);
			// Cancellation can occur after the race settled, before this continuation resumes.
			if (controller.signal.aborted) {
				opened.channel.dispose();
				throw interruptionFailure();
			}
			return opened;
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", abort);
		}
	}

	async #connect(actor: TerminalSessionActor, signal: AbortSignal): Promise<OpenedTerminalChannel> {
		requireOpening(signal);
		const target = await this.#targets.resolve(actor.sessionId);
		requireOpening(signal);
		const prepared = await this.#sandbox.prepareTerminal({ target, signal });
		requireOpening(signal);
		const channel = await this.#broker.open({
			target,
			launch: { kind: "sandboxed_exec", command: prepared.command, confirmation: prepared.confirmation },
			geometry: actor.view.geometry,
			term: actor.view.term,
			signal,
			onData: (bytes) => actor.acceptSshData(bytes),
		});
		return { channel, sandbox: prepared.sandbox };
	}
}

function openingCancelled(): TerminalError {
	return new TerminalError("terminal_session_unavailable", "Terminal opening was cancelled", { status: 409 });
}

function requireOpening(signal: AbortSignal): void {
	if (signal.aborted) throw openingCancelled();
}
