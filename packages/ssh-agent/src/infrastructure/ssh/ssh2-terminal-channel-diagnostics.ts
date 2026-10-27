import { randomUUID } from "node:crypto";
import type { OpenTerminalChannelInput, TerminalChannelExit } from "../../application/ssh-channel-broker.ts";

type CloseSource = "channel_close" | "channel_error" | "transport_close" | "startup_failure";
const SIGNALS = new Set(["ABRT", "ALRM", "BUS", "CHLD", "CONT", "FPE", "HUP", "ILL", "INT", "IO", "KILL",
	"PIPE", "POLL", "PROF", "PWR", "QUIT", "SEGV", "STOP", "SYS", "TERM", "TRAP", "TSTP", "TTIN", "TTOU", "URG", "USR1", "USR2", "VTALRM", "WINCH", "XCPU", "XFSZ"]);

/** Copies allowlisted metadata only; never logs or retains commands, output, raw input, or SSH error descriptions. */
export class TerminalChannelDiagnostics {
	readonly #identity;
	readonly #log: (record: Readonly<Record<string, unknown>>) => void;
	readonly #openedAt = Date.now();
	#exitReported = false;
	#exitCode: number | null = null;
	#exitSignal: string | null = null;
	#localCloseRequested = false;
	#localDisposeRequested = false;
	#outputStarted = false;
	#writeCount = 0;
	#lastWriteAt: number | null = null;
	#lastWriteByteLength: number | null = null;

	constructor(input: OpenTerminalChannelInput, connectionGeneration: number,
		log: (record: Readonly<Record<string, unknown>>) => void = record => console.info("SSH Agent Terminal channel diagnostic", record)) {
		this.#identity = { backendProcessId: process.pid, channelId: randomUUID(), workspaceId: input.target.workspaceId,
			sessionId: input.diagnosticContext?.sessionId ?? null, terminalSessionId: input.diagnosticContext?.terminalSessionId ?? null,
			sandboxBackend: input.diagnosticContext?.sandboxBackend ?? null, launchKind: input.launch.kind, connectionGeneration };
		this.#log = log;
		this.#record("terminal.channel.opened");
	}

	exited(code: number | null, signal?: string): void {
		this.#exitReported = true;
		this.#exitCode = typeof code === "number" && Number.isSafeInteger(code) ? code : null;
		const normalized = signal?.replace(/^SIG/, "");
		this.#exitSignal = normalized === undefined ? null : SIGNALS.has(normalized) ? normalized : "unknown";
		this.#record("terminal.channel.exit");
	}

	closed(source: CloseSource, kind: TerminalChannelExit["kind"]): void {
		this.#record("terminal.channel.closed", { closeSource: source, kind });
	}

	startOutput(): void { this.#outputStarted = true; }
	requestClose(): void { this.#localCloseRequested = true; }
	requestDispose(): void { this.#localDisposeRequested = true; }
	write(byteLength: number): void {
		this.#writeCount++;
		this.#lastWriteAt = Date.now();
		this.#lastWriteByteLength = byteLength;
	}

	#record(event: string, extra: Readonly<Record<string, unknown>> = {}): void {
		try {
			this.#log({ event, ...this.#identity, openedAt: this.#openedAt, emittedAt: Date.now(),
				exitReported: this.#exitReported, exitCode: this.#exitCode, exitSignal: this.#exitSignal,
				localCloseRequested: this.#localCloseRequested, localDisposeRequested: this.#localDisposeRequested,
				outputStarted: this.#outputStarted, writeCount: this.#writeCount,
				lastWriteAt: this.#lastWriteAt, lastWriteByteLength: this.#lastWriteByteLength, ...extra });
		} catch {
			// Diagnostics cannot change channel completion, disposal, or error propagation.
		}
	}
}
