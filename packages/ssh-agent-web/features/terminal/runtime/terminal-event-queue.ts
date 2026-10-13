import type { TerminalSseEnvelope } from "../model/terminal";
import { TERMINAL_UI_DEFAULTS } from "../model/terminal-ui-defaults";
import { stringData } from "./terminal-event-stream";

interface PendingEvent {
	envelope: TerminalSseEnvelope;
	output: Uint8Array | null;
}

interface Options {
	initialSequence: number;
	writeOutput(bytes: Uint8Array, sequence: number): Promise<void>;
	applyEvent(envelope: TerminalSseEnvelope, appliedSequence: number): void | Promise<void>;
	onError(error: unknown): void;
}

/** Preserve protocol boundaries while avoiding one asynchronous xterm write per SSH fragment. */
export class TerminalEventQueue {
	readonly #options: Options;
	readonly #pending: PendingEvent[] = [];
	#receivedSequence: number;
	#appliedSequence: number;
	#pendingEvents = 0;
	#pendingBytes = 0;
	#closed = false;
	#running = false;
	#drainTimer: ReturnType<typeof setTimeout> | undefined;
	#operationTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: Options) {
		this.#options = options;
		this.#receivedSequence = this.#appliedSequence = options.initialSequence;
	}

	push(envelope: TerminalSseEnvelope): void {
		if (this.#closed) return;
		try {
			if (envelope.sequence !== null) {
				if (envelope.sequence <= this.#receivedSequence) return;
				if (envelope.sequence !== this.#receivedSequence + 1) throw new Error("Terminal event sequence gap");
			}
			let output: Uint8Array | null = null;
			if (envelope.type === "terminal.output") {
				const encoded = stringData(envelope.data, "bytesBase64");
				if (encoded === null || envelope.sequence === null) throw new Error("Invalid Terminal output event");
				output = decodeTerminalBytes(encoded);
			}
			if (this.#pendingEvents + 1 > TERMINAL_UI_DEFAULTS.pendingEventLimit ||
				this.#pendingBytes + (output?.byteLength ?? 0) > TERMINAL_UI_DEFAULTS.pendingOutputBytes) {
				throw new Error("Terminal display backlog requires a new snapshot");
			}
			if (envelope.sequence !== null) this.#receivedSequence = envelope.sequence;
			this.#pending.push({ envelope, output });
			this.#pendingEvents += 1;
			this.#pendingBytes += output?.byteLength ?? 0;
			if (!this.#running && this.#drainTimer === undefined) {
				// Timers continue draining hidden tabs; animation frames may stop entirely.
				this.#drainTimer = setTimeout(() => {
					this.#drainTimer = undefined;
					void this.#drain().catch((error: unknown) => this.#fail(error));
				}, 0);
			}
		} catch (error) {
			this.#fail(error);
		}
	}

	close(): void {
		this.#closed = true;
		if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer);
		if (this.#operationTimer !== undefined) clearTimeout(this.#operationTimer);
		this.#pending.length = 0;
		this.#pendingEvents = this.#pendingBytes = 0;
	}

	async #drain(): Promise<void> {
		this.#running = true;
		while (!this.#closed && this.#pending.length > 0) {
			const first = this.#pending[0]!;
			let count = 1;
			let byteLength = first.output?.byteLength ?? 0;
			if (first.output !== null) {
				while (count < this.#pending.length) {
					const next = this.#pending[count]!;
					if (next.output === null || byteLength + next.output.byteLength > TERMINAL_UI_DEFAULTS.outputBatchBytes) break;
					byteLength += next.output.byteLength;
					count += 1;
				}
			}
			const batch = this.#pending.splice(0, count);
			const lastSequence = batch.at(-1)!.envelope.sequence;
			this.#operationTimer = setTimeout(() => {
				this.#fail(new Error("Terminal event processing timed out"));
			}, TERMINAL_UI_DEFAULTS.eventProcessingTimeoutMs);
			if (first.output !== null) {
				const bytes = new Uint8Array(byteLength);
				let offset = 0;
				for (const event of batch) {
					bytes.set(event.output!, offset);
					offset += event.output!.byteLength;
				}
				await this.#options.writeOutput(bytes, lastSequence!);
			} else {
				await this.#options.applyEvent(first.envelope, this.#appliedSequence);
			}
			if (this.#closed) return;
			clearTimeout(this.#operationTimer);
			this.#operationTimer = undefined;
			if (lastSequence !== null) this.#appliedSequence = lastSequence;
			this.#pendingEvents -= count;
			this.#pendingBytes -= byteLength;
		}
		this.#running = false;
	}

	#fail(error: unknown): void {
		if (this.#closed) return;
		this.close();
		this.#options.onError(error);
	}
}

export function decodeTerminalBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
