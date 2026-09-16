import type { TerminalGeometry, TerminalSessionStatus } from "../../domain/terminal.ts";
import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";

export type TerminalSequencedEvent =
	| {
			readonly sequence: number;
			readonly type: "terminal.output";
			readonly emittedAt: number;
			readonly bytes: Uint8Array;
	  }
	| {
			readonly sequence: number;
			readonly type: "terminal.resized";
			readonly emittedAt: number;
			readonly geometry: TerminalGeometry;
			readonly ownerAttachmentId: string;
			readonly ownershipEpoch: number;
	  }
	| {
			readonly sequence: number;
			readonly type: "terminal.resize_owner_changed";
			readonly emittedAt: number;
			readonly ownerAttachmentId: string | null;
			readonly ownershipEpoch: number;
	  }
	| {
			readonly sequence: number;
			readonly type: "terminal.status";
			readonly emittedAt: number;
			readonly oldStatus: TerminalSessionStatus;
			readonly newStatus: TerminalSessionStatus;
			readonly reason: string | null;
	  }
	| {
			readonly sequence: number;
			readonly type:
				| "terminal.input"
				| "terminal.observation.captured"
				| "terminal.observation.delivered"
				| "terminal.observation.processing"
				| "terminal.observation.finished";
			readonly emittedAt: number;
			readonly data: Readonly<Record<string, string | number | boolean | null>>;
	  };

export interface TerminalReplayResult {
	readonly events: readonly TerminalSequencedEvent[];
	readonly oldestAvailableSequence: number | null;
	readonly latestSequence: number | null;
}

export class TerminalReplayRing {
	readonly #maxOutputBytes: number;
	readonly #maxFrames: number;
	readonly #frames: TerminalSequencedEvent[] = [];
	#outputBytes = 0;

	constructor(
		options: {
			readonly maxOutputBytes?: number;
			readonly maxFrames?: number;
		} = {},
	) {
		this.#maxOutputBytes = options.maxOutputBytes ?? TERMINAL_DEFAULTS.replay.outputBytes;
		this.#maxFrames = options.maxFrames ?? TERMINAL_DEFAULTS.replay.frames;
	}

	get outputBytes(): number {
		return this.#outputBytes;
	}

	get frameCount(): number {
		return this.#frames.length;
	}

	append(event: TerminalSequencedEvent): void {
		const previous = this.#frames.at(-1);
		if (previous && event.sequence !== previous.sequence + 1) {
			throw new Error(`Terminal event sequence must be contiguous: ${previous.sequence} -> ${event.sequence}`);
		}
		const stored = event.type === "terminal.output" ? { ...event, bytes: event.bytes.slice() } : event;
		this.#frames.push(stored);
		if (stored.type === "terminal.output") this.#outputBytes += stored.bytes.byteLength;
		while (this.#frames.length > this.#maxFrames || this.#outputBytes > this.#maxOutputBytes) {
			const removed = this.#frames.shift();
			if (removed?.type === "terminal.output") this.#outputBytes -= removed.bytes.byteLength;
		}
	}

	replayAfter(sequence: number): TerminalReplayResult {
		const oldest = this.#frames[0]?.sequence ?? null;
		const latest = this.#frames.at(-1)?.sequence ?? null;
		if (oldest !== null && sequence < oldest - 1) {
			throw new TerminalReplayGapError(sequence, oldest, latest ?? oldest);
		}
		return {
			events: this.#frames.filter((event) => event.sequence > sequence),
			oldestAvailableSequence: oldest,
			latestSequence: latest,
		};
	}
}

export class TerminalReplayGapError extends Error {
	readonly requestedAfter: number;
	readonly oldestAvailable: number;
	readonly latest: number;

	constructor(requestedAfter: number, oldestAvailable: number, latest: number) {
		super("Terminal replay gap requires a new snapshot");
		this.name = "TerminalReplayGapError";
		this.requestedAfter = requestedAfter;
		this.oldestAvailable = oldestAvailable;
		this.latest = latest;
	}
}
