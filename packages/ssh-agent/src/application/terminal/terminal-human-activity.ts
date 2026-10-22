import { Buffer } from "node:buffer";
import type { Clock, IdGenerator } from "../../domain/ids.ts";
import type { TerminalHumanActivity } from "../../domain/terminal-human.ts";
import type { TerminalRepository } from "../repositories/terminal-repository.ts";
import type { TerminalCanonicalCapture, TerminalSessionActor } from "./terminal-session-actor.ts";
import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";

/** Projects parsed terminal text, never keyboard bytes or ANSI input, into bounded durable evidence. */
export class TerminalHumanActivityRecorder {
	readonly #repository: TerminalRepository;
	readonly #clock: Clock;
	readonly #ids: IdGenerator;
	#activity: TerminalHumanActivity | null = null;
	#previousText = "";
	#needsObservation = false;

	constructor(repository: TerminalRepository, clock: Clock, ids: IdGenerator) {
		this.#repository = repository; this.#clock = clock; this.#ids = ids;
	}

	get active(): boolean { return this.#activity !== null && this.#activity.finishedAt === null; }
	get needsObservation(): boolean { return this.#needsObservation; }
	observed(): void { this.#needsObservation = false; }

	begin(sessionId: string, terminalSessionId: string, bytes: number, capture: TerminalCanonicalCapture): void {
		const now = this.#clock.now();
		if (!this.active) {
			const pending = this.#needsObservation ? this.#activity : null;
			this.#activity = { id: this.#ids.next(), sessionId, terminalSessionId, startSequence: pending?.startSequence ?? capture.sequence,
				endSequence: capture.sequence, inputCount: pending?.inputCount ?? 0, inputBytes: pending?.inputBytes ?? 0,
				writeStatus: pending?.writeStatus === "uncertain" ? "uncertain" : "writing",
				transcript: pending?.transcript ?? "", screenText: capture.screenText, truncated: pending?.truncated ?? false,
				startedAt: pending?.startedAt ?? now, updatedAt: now, finishedAt: null, endReason: null };
			this.#previousText = capture.allText;
		}
		this.#needsObservation = true;
		this.#activity = { ...this.#activity!, inputCount: this.#activity!.inputCount + 1,
			inputBytes: this.#activity!.inputBytes + bytes,
			writeStatus: this.#activity!.writeStatus === "uncertain" ? "uncertain" : "writing", updatedAt: now };
		this.checkpoint(capture);
	}

	written(capture: TerminalCanonicalCapture, uncertain = false): void {
		if (!this.#activity) return;
		this.#activity = { ...this.#activity, writeStatus: uncertain || this.#activity.writeStatus === "uncertain" ? "uncertain" : "written",
			truncated: this.#activity.truncated || uncertain };
		this.checkpoint(capture);
	}

	track(capture: TerminalCanonicalCapture): void {
		if (!this.active) return;
		const activity = this.#activity!;
		const changed = capture.allText !== this.#previousText;
		const continuous = capture.allText.startsWith(this.#previousText);
		const added = !changed ? "" : continuous ? capture.allText.slice(this.#previousText.length)
			: `\n[Terminal redrawn; earlier visible state may be incomplete]\n${capture.allText}`;
		const screen = tail(capture.screenText, TERMINAL_DEFAULTS.observation.maxAgentViewBytes);
		const transcript = tail(activity.transcript + added,
			TERMINAL_DEFAULTS.observation.maxAgentViewBytes - Buffer.byteLength(screen.text));
		const now = this.#clock.now();
		this.#activity = { ...activity, transcript: transcript.text, screenText: screen.text,
			endSequence: capture.sequence, updatedAt: now,
			truncated: activity.truncated || !continuous || screen.truncated || transcript.truncated };
		this.#previousText = capture.allText;
	}

	checkpoint(capture: TerminalCanonicalCapture, reason?: NonNullable<TerminalHumanActivity["endReason"]>): void {
		if (!this.active) return;
		this.track(capture);
		const activity = this.#activity!;
		const next = { ...activity, ...(reason ? { finishedAt: this.#clock.now(), endReason: reason,
			truncated: activity.truncated || reason === "lost" } : {}) };
		this.#repository.saveHumanActivity(next);
		this.#activity = next;
	}
}

function tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text);
	if (bytes.byteLength <= maxBytes) return { text, truncated: false };
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
	return { text: bytes.subarray(start).toString("utf8"), truncated: true };
}

/** Let final keyboard echo arrive without waiting for the foreground program to finish. */
export async function settleHumanActivity(actor: TerminalSessionActor): Promise<void> {
	let quiet: ReturnType<typeof setTimeout>;
	let maximum: ReturnType<typeof setTimeout>;
	let unsubscribe = () => undefined as void;
	try {
		await new Promise<void>(resolve => {
			quiet = setTimeout(resolve, 150);
			maximum = setTimeout(resolve, 1000);
			unsubscribe = actor.subscribe(event => {
				if (event.type === "terminal.output") { clearTimeout(quiet); quiet = setTimeout(resolve, 150); }
				if (event.type === "terminal.status") resolve();
			});
		});
	} finally { clearTimeout(quiet!); clearTimeout(maximum!); unsubscribe(); }
}
