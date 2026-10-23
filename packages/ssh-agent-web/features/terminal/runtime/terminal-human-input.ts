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
const CONTROL_SYNC_TIMEOUT_MS = 10_000;

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
	#claiming = false;
	#pendingControl: TerminalInputControl | null = null;
	#focusDeferred = false;
	readonly #controlWaiters = new Set<() => void>();
	#sequence = 0;
	#pending: Uint8Array[] = [];
	#pendingBytes = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#controlTimer: ReturnType<typeof setTimeout> | undefined;
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
		this.#focused = focused;
		if (!focused && this.#claiming && this.#pendingBytes > 0)
			this.#fail(new Error("Terminal focus changed before queued input could acquire ownership"));
		this.#render(); this.#focusControl();
	}
	/** Revoke immediately; grants wait for preceding output in the display queue. */
	revokeControl(control: TerminalInputControl): void {
		if (this.#closed || control.epoch <= this.#control.epoch ||
			this.#pendingControl && control.epoch < this.#pendingControl.epoch) return;
		if (control.mode === "human" && control.attachmentId === this.#options.attachmentId) return;
		this.#setPendingControl(control);
		this.#claiming = false;
		this.#focusDeferred = false;
		if (this.#pendingBytes > 0)
			this.#fail(new Error("Terminal input ownership changed before queued input was sent"));
		this.#render();
	}
	updateControl(control: TerminalInputControl): void {
		if (this.#closed || control.epoch < this.#control.epoch) return;
		const previous = this.#control;
		const acquiring = this.#claiming && !this.#ownsInput() && control.mode === "human" &&
			control.attachmentId === this.#options.attachmentId;
		this.#control = control;
		const synchronized = this.#pendingControl !== null && control.epoch >= this.#pendingControl.epoch;
		if (synchronized) this.#pendingControl = null;
		if (control.epoch !== previous.epoch) {
			this.#sequence = 0;
			if (this.#pendingBytes > 0 && !acquiring)
				this.#fail(new Error("Terminal input ownership changed before queued input was sent"));
		}
		if (this.#ownsInput() || control.mode === "agent") this.#claiming = false;
		this.#render();
		if (synchronized) this.#wakeControlWaiters();
		const agentFinished = previous.mode === "agent" && control.mode === "idle";
		const focusNeedsUpdate = this.#focusDeferred || (!this.#focused || this.#fault) && this.#ownsInput();
		if (agentFinished || synchronized && focusNeedsUpdate) {
			this.#focusDeferred = false;
			this.#focusControl();
		}
	}

	enqueue(bytes: Uint8Array): void {
		if (!this.#enabled() || bytes.length === 0) return;
		if (this.#pendingBytes + bytes.length > MAX_PENDING) {
			this.#fail(new Error("Terminal input queue is full; queued input was stopped and will not be replayed")); return;
		}
		this.#pending.push(bytes.slice()); this.#pendingBytes += bytes.length;
		if (this.#ownsInput() && this.#timer === undefined)
			this.#timer = setTimeout(() => { this.#timer = undefined; void this.#flush().catch(() => undefined); }, 16);
	}

	async prepare(): Promise<void> {
		this.#paused = true; this.#render();
		this.#requireAvailable();
		// Already captured keys may still be waiting for their first ownership grant.
		await this.#controlTail;
		await this.#waitForControl();
		await this.#flush();
		await this.#controlTail;
		await this.#waitForControl();
		if (this.#ownsInput())
			this.#acceptControlResponse(await this.#options.claim(false));
		await this.#waitForControl();
	}
	resume(): void { if (this.#closed) return; this.#paused = false; this.#render(); this.#focusControl(); }
	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#pending = []; this.#pendingBytes = 0;
		this.#wakeControlWaiters();
	}

	#ownsInput(): boolean {
		return this.#control.mode === "human" && this.#control.attachmentId === this.#options.attachmentId;
	}
	#enabled(): boolean {
		const awaitingOwnGrant = this.#claiming && (this.#pendingControl === null ||
			this.#pendingControl.mode === "human" && this.#pendingControl.attachmentId === this.#options.attachmentId);
		return this.#live && this.#focused && !this.#paused && !this.#busy && !this.#closed && !this.#fault &&
			(this.#pendingControl === null && this.#ownsInput() || awaitingOwnGrant);
	}
	#requireAvailable(): void {
		if (this.#fault) throw this.#fault;
		if (this.#closed) throw new Error("Terminal input is closed; synchronize the terminal before submitting");
	}
	async #waitForControl(): Promise<void> {
		this.#requireAvailable();
		while (this.#pendingControl) {
			await new Promise<void>((resolve) => this.#controlWaiters.add(resolve));
			this.#requireAvailable();
		}
	}
	#setPendingControl(control: TerminalInputControl): void {
		this.#pendingControl = control;
		if (this.#controlTimer !== undefined || this.#closed || this.#fault) return;
		this.#controlTimer = setTimeout(() => {
			this.#controlTimer = undefined;
			this.#fail(new Error("Terminal input control synchronization timed out; synchronize the terminal before continuing"));
		}, CONTROL_SYNC_TIMEOUT_MS);
	}
	#wakeControlWaiters(): void {
		clearTimeout(this.#controlTimer);
		this.#controlTimer = undefined;
		for (const resolve of this.#controlWaiters) resolve();
		this.#controlWaiters.clear();
	}
	#acceptControlResponse(control: TerminalInputControl): void {
		if (this.#closed) return;
		const newOwnGrant = control.mode === "human" && control.attachmentId === this.#options.attachmentId &&
			control.epoch > this.#control.epoch;
		if (newOwnGrant && !this.#pendingControl) this.#setPendingControl(control);
		if (this.#pendingControl) {
			// HTTP confirms ownership, but only the display queue can clear its boundary.
			if (control.epoch > this.#pendingControl.epoch) this.#setPendingControl(control);
			this.#render();
			return;
		}
		this.updateControl(control);
	}
	#render(): void {
		if (this.#closed) return;
		const phase = !this.#live || this.#fault ? "unavailable" : this.#paused ? "handoff"
			: this.#busy || this.#pendingControl?.mode === "agent" || this.#control.mode === "agent" ? "agent"
			: this.#claiming || this.#pendingControl ? "handoff"
			: this.#control.mode === "human" && this.#control.attachmentId !== this.#options.attachmentId ? "other" : "ready";
		this.#options.onState(phase, this.#enabled());
	}
	#focusControl(): void {
		if (this.#closed) return;
		if (this.#pendingControl) { this.#focusDeferred = true; return; }
		if (this.#live && this.#focused && !this.#paused && !this.#busy && !this.#fault &&
			!this.#pendingControl && this.#control.mode !== "agent" && !this.#ownsInput()) {
			this.#claiming = true;
			this.#render();
		}
		this.#controlTail = this.#controlTail.then(() => this.#synchronizeFocus()).catch(error => {
			this.#claiming = false;
			// A Run can still be completing cleanup after its idle SSE reached the browser.
			if (this.#pendingBytes === 0 && error && typeof error === "object" && "code" in error && error.code === "session_has_active_chat_run") {
				this.#render(); return;
			}
			this.#fail(error);
		});
	}
	async #synchronizeFocus(): Promise<void> {
		if (this.#closed || !this.#live || this.#pendingControl) return;
		if (!this.#focused || this.#fault) {
			this.#claiming = false;
			if (this.#ownsInput()) {
				if (!this.#fault) await this.#flush();
				if (!this.#closed) this.#acceptControlResponse(await this.#options.claim(false));
			}
			return;
		}
		if (this.#control.mode === "agent") return;
		if ((this.#paused || this.#busy) && this.#pendingBytes === 0) {
			this.#claiming = false;
			this.#render();
			return;
		}
		if (this.#ownsInput()) return;
		this.#claiming = true;
		this.#render();
		const granted = await this.#options.claim(true);
		this.#acceptControlResponse(granted);
		if (this.#closed) return;
		if (!this.#focused || this.#fault) {
			this.#claiming = false;
			if (this.#ownsInput() || granted.mode === "human" && granted.attachmentId === this.#options.attachmentId)
				this.#acceptControlResponse(await this.#options.claim(false));
			return;
		}
		await this.#waitForControl();
		this.#claiming = false;
		if (!this.#ownsInput() && this.#pendingBytes > 0)
			throw new Error("Terminal input ownership was not granted; queued input was not sent");
		this.#render();
		if (this.#ownsInput() && this.#pendingBytes > 0) await this.#flush();
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
				if (!this.#ownsInput() || this.#pendingControl)
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
			this.#requireAvailable();
		} catch (error) { this.#fail(error); throw error; }
	}
	#fail(error: unknown): void {
		if (this.#fault) return;
		this.#fault = error; this.#claiming = false;
		this.#pending = []; this.#pendingBytes = 0; clearTimeout(this.#timer);
		this.#wakeControlWaiters();
		if (this.#closed) return;
		this.#render(); this.#options.onError(error);
	}
}
