import type { ChatRunEventHub } from "../chat-run-event-hub.ts";
import { SESSION_ACTIVITY_EVENT_TYPES, SessionActivityProjector } from "./session-activity-projector.ts";
import { SessionActivityStream } from "./session-activity-stream.ts";

/** Adapter between existing business facts and the independent activity projection. */
export class SessionActivityService {
	readonly #projector = new SessionActivityProjector();
	readonly #stream = new SessionActivityStream(() => this.#projector.snapshot());
	readonly #unobserve: () => void;

	constructor(events: ChatRunEventHub) {
		this.#unobserve = events.observe(SESSION_ACTIVITY_EVENT_TYPES, (event) => {
			const update = this.#projector.apply(event);
			if (update) this.#stream.publish(update);
		});
	}

	subscribe(signal?: AbortSignal): ReadableStream<Uint8Array> { return this.#stream.subscribe(signal); }
	close(): void { this.#unobserve(); this.#stream.close(); this.#projector.clear(); }
}
