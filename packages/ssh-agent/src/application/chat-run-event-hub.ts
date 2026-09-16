import type { BackendLocale } from "../i18n/message.ts";
import { ChatRunEventStream } from "./chat-run-event-stream.ts";
import { MAX_CACHED_CHAT_RUN_STREAMS } from "./chat-runtime-defaults.ts";

export interface ChatEventPublisher {
	publish(runId: string, type: string, data: unknown): void;
}

export class ChatRunEventHub implements ChatEventPublisher {
	readonly #maxCachedRunStreams: number;
	readonly #streams = new Map<string, ChatRunEventStream>();

	constructor(options: { maxCachedRunStreams?: number } = {}) {
		this.#maxCachedRunStreams = options.maxCachedRunStreams ?? MAX_CACHED_CHAT_RUN_STREAMS;
		if (!Number.isSafeInteger(this.#maxCachedRunStreams) || this.#maxCachedRunStreams <= 0) {
			throw new Error("maxCachedRunStreams must be a positive safe integer");
		}
	}

	publish(runId: string, type: string, data: unknown): void {
		this.#stream(runId).publish(type, data);
	}

	subscribe(runId: string, lastEventId?: number, locale?: BackendLocale): ReadableStream<Uint8Array> {
		return this.#stream(runId).subscribe(lastEventId, locale);
	}

	close(): void {
		for (const stream of this.#streams.values()) stream.close();
		this.#streams.clear();
	}

	#stream(runId: string): ChatRunEventStream {
		let stream = this.#streams.get(runId);
		if (stream) return stream;
		stream = new ChatRunEventStream(runId);
		this.#streams.set(runId, stream);
		if (this.#streams.size > this.#maxCachedRunStreams) {
			const oldest = this.#streams.entries().next().value;
			if (oldest !== undefined) {
				oldest[1].close();
				this.#streams.delete(oldest[0]);
			}
		}
		return stream;
	}
}
