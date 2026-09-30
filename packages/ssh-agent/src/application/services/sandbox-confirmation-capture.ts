import { Buffer } from "node:buffer";

type ConfirmationState = "waiting" | "confirmed" | "missing";

/** Holds stderr until the launcher confirms confinement, without exposing its protocol line. */
export class SandboxConfirmationCapture {
	#state: ConfirmationState;
	#pending = Buffer.alloc(0);
	readonly #marker?: Buffer;
	readonly #onConfirmed: () => Promise<void>;
	readonly #onOutput: (chunk: Uint8Array) => Promise<void>;

	constructor(input: {
		marker?: string;
		onConfirmed(): Promise<void>;
		onOutput(chunk: Uint8Array): Promise<void>;
	}) {
		this.#marker = input.marker === undefined ? undefined : Buffer.from(input.marker);
		this.#state = this.#marker === undefined ? "confirmed" : "waiting";
		this.#onConfirmed = input.onConfirmed;
		this.#onOutput = input.onOutput;
	}

	get confirmed(): boolean { return this.#state === "confirmed"; }

	async write(chunk: Uint8Array): Promise<void> {
		if (this.#state !== "waiting" || this.#marker === undefined) return this.#onOutput(chunk);
		this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
		const offset = this.findMarker();
		if (offset < 0 && this.#pending.length < 4096) return;
		this.#state = offset < 0 ? "missing" : "confirmed";
		if (offset >= 0) await this.#onConfirmed();
		if (offset > 0) await this.#onOutput(this.#pending.subarray(0, offset));
		const remainder = offset < 0 ? this.#pending : this.#pending.subarray(offset + this.#marker.length);
		if (remainder.length > 0) await this.#onOutput(remainder);
		this.#pending = Buffer.alloc(0);
	}

	async finish(): Promise<void> {
		if (this.#state !== "waiting") return;
		this.#state = "missing";
		if (this.#pending.length > 0) await this.#onOutput(this.#pending);
		this.#pending = Buffer.alloc(0);
	}

	private findMarker(): number {
		if (this.#marker === undefined || this.#marker.length === 0) return -1;
		let offset = this.#pending.indexOf(this.#marker);
		while (offset > 0 && this.#pending[offset - 1] !== 10) offset = this.#pending.indexOf(this.#marker, offset + 1);
		return offset;
	}
}
