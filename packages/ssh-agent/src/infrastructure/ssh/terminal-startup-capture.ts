import { Buffer } from "node:buffer";

type StartupState = "waiting" | "confirmed" | "missing";

/** Owns the bounded PTY prefix until the native launcher reports confinement. */
export class TerminalStartupCapture {
	#state: StartupState = "waiting";
	#pending = Buffer.alloc(0);
	readonly #marker: Buffer;

	constructor(marker: string) {
		if (!marker || marker.includes("\r") || marker.includes("\n")) throw new Error("Invalid terminal confirmation marker");
		this.#marker = Buffer.from(marker);
	}

	get confirmed(): boolean { return this.#state === "confirmed"; }

	write(chunk: Uint8Array): Buffer {
		if (this.#state === "missing") throw new Error("Terminal confinement confirmation is missing");
		if (this.#state === "confirmed") return Buffer.from(chunk);
		this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
		let lineStart = 0;
		let lineEnd = this.#pending.indexOf(10);
		while (lineEnd >= 0) {
			if (lineStart > 4096) {
				this.#state = "missing";
				throw new Error("Terminal confinement confirmation exceeded its output limit");
			}
			const line = this.#pending.subarray(lineStart, lineEnd);
			const content = line.at(-1) === 13 ? line.subarray(0, -1) : line;
			if (content.equals(this.#marker)) {
				const before = this.#pending.subarray(0, lineStart);
				const remainder = this.#pending.subarray(lineEnd + 1);
				// Earlier diagnostic lines were retained in #pending until this exact protocol line.
				this.#state = "confirmed";
				this.#pending = Buffer.alloc(0);
				return Buffer.concat([before, remainder]);
			}
			lineStart = lineEnd + 1;
			lineEnd = this.#pending.indexOf(10, lineStart);
		}
		if (this.#pending.length > 4096) {
			this.#state = "missing";
			throw new Error("Terminal confinement confirmation exceeded its output limit");
		}
		return Buffer.alloc(0);
	}
}
