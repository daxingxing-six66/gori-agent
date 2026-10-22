import type { TerminalInputControl } from "../model/terminal";

export type HumanInputPhase = "ready" | "handoff" | "agent" | "other" | "unavailable";
interface Options {
	attachmentId: string;
	control: TerminalInputControl;
	claim(claim: boolean): Promise<TerminalInputControl>;
	write(epoch: number, sequence: number, bytes: Uint8Array): Promise<{ acceptedSequence: number }>;
	onState(phase: HumanInputPhase, enabled: boolean): void;
	onError(error: unknown): void;
}

const MAX_BATCH = 32 * 1024;
const MAX_PENDING = 256 * 1024;

/** An ordered, bounded input queue. Faults never retry bytes, even after reconnect. */
export class TerminalHumanInput {
	readonly #options: Options;
	#control: TerminalInputControl;
	#live = false;
	#focused = false;
	#paused = false;
	#busy = false;
	#closed = false;
	#fault: unknown = null;
	#sequence = 0;
	#pending: Uint8Array[] = [];
	#pendingBytes = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#draining: Promise<void> | null = null;
	#controlTail: Promise<void> = Promise.resolve();

	constructor(options: Options) { this.#options = options; this.#control = options.control; this.#render(); }

	ready(): void { this.#live = true; this.#render(); this.#focusControl(); }
	setBusy(busy: boolean): void { this.#busy = busy; this.#render(); if (!busy) this.#focusControl(); }
	setFocused(focused: boolean): void {
		if (this.#focused === focused) {
			if (focused && this.#control.mode === "idle") this.#focusControl();
			return;
		}
		this.#focused = focused; this.#render(); this.#focusControl();
	}
	updateControl(control: TerminalInputControl): void {
		if (this.#closed || control.epoch < this.#control.epoch) return;
		const previous = this.#control;
		this.#control = control;
		if (control.epoch !== previous.epoch) {
			this.#sequence = 0;
			if (this.#pendingBytes > 0) this.#fail(new Error("Terminal input ownership changed before queued input was sent"));
		}
		this.#render();
		if (previous.mode === "agent" && control.mode === "idle") this.#focusControl();
	}

	enqueue(bytes: Uint8Array): void {
		if (!this.#enabled() || bytes.length === 0) return;
		if (this.#pendingBytes + bytes.length > MAX_PENDING) {
			this.#fail(new Error("Terminal input queue is full; queued input was stopped and will not be replayed")); return;
		}
		this.#pending.push(bytes.slice()); this.#pendingBytes += bytes.length;
		if (this.#timer === undefined) this.#timer = setTimeout(() => { this.#timer = undefined; void this.#flush().catch(() => undefined); }, 16);
	}

	async prepare(): Promise<void> {
		this.#paused = true; this.#render();
		if (this.#fault) throw this.#fault;
		await this.#flush();
		await this.#controlTail;
		if (this.#fault) throw this.#fault;
		if (!this.#closed && this.#control.attachmentId === this.#options.attachmentId)
			this.updateControl(await this.#options.claim(false));
	}
	resume(): void { this.#paused = false; this.#render(); this.#focusControl(); }
	close(): void { this.#closed = true; clearTimeout(this.#timer); this.#pending = []; this.#pendingBytes = 0; }

	#enabled(): boolean {
		return this.#live && this.#focused && !this.#paused && !this.#busy && !this.#closed && !this.#fault &&
			this.#control.mode === "human" && this.#control.attachmentId === this.#options.attachmentId;
	}
	#render(): void {
		if (this.#closed) return;
		const phase = !this.#live || this.#fault ? "unavailable" : this.#paused ? "handoff"
			: this.#busy || this.#control.mode === "agent" ? "agent"
			: this.#control.mode === "human" && this.#control.attachmentId !== this.#options.attachmentId ? "other" : "ready";
		this.#options.onState(phase, this.#enabled());
	}
	#focusControl(): void {
		this.#controlTail = this.#controlTail.then(async () => {
			if (this.#closed || !this.#live || this.#paused || this.#busy || this.#fault || this.#control.mode === "agent") return;
			const focused = this.#focused;
			if (focused && this.#control.attachmentId === this.#options.attachmentId ||
				!focused && this.#control.attachmentId !== this.#options.attachmentId) return;
			await this.#flush();
			if (this.#closed) return;
			this.updateControl(await this.#options.claim(focused));
		}).catch(error => {
			// A Run can still be completing cleanup after its idle SSE reached the browser.
			if (error && typeof error === "object" && "code" in error && error.code === "session_has_active_chat_run") {
				this.#render(); return;
			}
			this.#fail(error);
		});
	}
	#flush(): Promise<void> {
		clearTimeout(this.#timer); this.#timer = undefined;
		if (this.#draining) return this.#draining;
		const task = this.#drain();
		this.#draining = task;
		void task.finally(() => { if (this.#draining === task) this.#draining = null; }).catch(() => undefined);
		return task;
	}
	async #drain(): Promise<void> {
		try {
			while (this.#pendingBytes > 0 && !this.#closed && !this.#fault) {
				const epoch = this.#control.epoch;
				if (this.#control.mode !== "human" || this.#control.attachmentId !== this.#options.attachmentId)
					throw new Error("Terminal input ownership changed");
				const batch = new Uint8Array(Math.min(MAX_BATCH, this.#pendingBytes));
				let offset = 0;
				while (offset < batch.length) {
					const first = this.#pending[0]!;
					const count = Math.min(first.length, batch.length - offset);
					batch.set(first.subarray(0, count), offset); offset += count;
					if (count === first.length) this.#pending.shift(); else this.#pending[0] = first.subarray(count);
				}
				this.#pendingBytes -= batch.length;
				const sequence = ++this.#sequence;
				const result = await this.#options.write(epoch, sequence, batch);
				if (result.acceptedSequence !== sequence) throw new Error("Terminal input acknowledgement mismatch");
			}
			if (this.#fault) throw this.#fault;
		} catch (error) { this.#fail(error); throw error; }
	}
	#fail(error: unknown): void {
		if (this.#closed || this.#fault) return;
		this.#fault = error; this.#pending = []; this.#pendingBytes = 0; clearTimeout(this.#timer);
		this.#render(); this.#options.onError(error);
	}
}
