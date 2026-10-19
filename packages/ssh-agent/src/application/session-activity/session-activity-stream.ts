import type { SessionActivity, SessionActivityEvent, SessionActivityUpdate } from "../../domain/session-activity.ts";

interface Subscriber {
	controller: ReadableStreamDefaultController<Uint8Array>;
	dispose(): void;
}

/** One global stream per browser, with a fresh authoritative snapshot on every connection. */
export class SessionActivityStream {
	readonly #snapshot: () => readonly SessionActivity[];
	readonly #subscribers = new Set<Subscriber>();
	readonly #encoder = new TextEncoder();
	#heartbeat?: ReturnType<typeof setInterval>;
	#closed = false;

	constructor(snapshot: () => readonly SessionActivity[]) { this.#snapshot = snapshot; }

	subscribe(signal?: AbortSignal): ReadableStream<Uint8Array> {
		let subscriber: Subscriber | undefined;
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (this.#closed || signal?.aborted) { controller.close(); return; }
				const onAbort = () => { if (subscriber) this.#remove(subscriber); };
				subscriber = { controller, dispose: () => signal?.removeEventListener("abort", onAbort) };
				this.#subscribers.add(subscriber);
				signal?.addEventListener("abort", onAbort, { once: true });
				controller.enqueue(this.#encode({ type: "activity.snapshot", data: { activities: this.#snapshot() } }));
				this.#heartbeat ??= setInterval(() => this.#broadcast(this.#encoder.encode(": heartbeat\n\n")), 30_000);
				this.#heartbeat.unref();
			},
			cancel: () => { if (subscriber) this.#remove(subscriber, false); },
		}, { highWaterMark: 64 });
	}

	publish(update: SessionActivityUpdate): void {
		this.#broadcast(this.#encode({ type: "activity.updated", data: update }));
	}

	close(): void {
		this.#closed = true;
		for (const subscriber of this.#subscribers) this.#remove(subscriber);
	}

	#broadcast(bytes: Uint8Array): void {
		for (const subscriber of this.#subscribers) {
			// A slow reader reconnects to a full snapshot instead of retaining an unbounded backlog.
			if ((subscriber.controller.desiredSize ?? 0) <= 0) { this.#remove(subscriber); continue; }
			try { subscriber.controller.enqueue(bytes); }
			catch { this.#remove(subscriber, false); }
		}
	}

	#remove(subscriber: Subscriber, close = true): void {
		if (!this.#subscribers.delete(subscriber)) return;
		subscriber.dispose();
		if (close) { try { subscriber.controller.close(); } catch { /* Already disconnected. */ } }
		if (this.#subscribers.size === 0) { clearInterval(this.#heartbeat); this.#heartbeat = undefined; }
	}

	#encode(event: SessionActivityEvent): Uint8Array {
		return this.#encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
	}
}
