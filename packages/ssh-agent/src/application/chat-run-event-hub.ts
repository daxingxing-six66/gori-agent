import type { BackendLocale } from "../i18n/message.ts";
import { ChatRunEventStream } from "./chat-run-event-stream.ts";
import { MAX_CACHED_CHAT_RUN_STREAMS } from "./chat-runtime-defaults.ts";
import { reportFailure } from "./failure-reporter.ts";

export interface PublishedChatEvent {
	readonly runId: string;
	readonly type: string;
	readonly data: unknown;
}

type ChatEventObserver = (event: PublishedChatEvent) => void;

export interface ChatEventPublisher {
	publish(runId: string, type: string, data: unknown): void;
}

export class ChatRunEventHub implements ChatEventPublisher {
	readonly #maxCachedRunStreams: number;
	readonly #streams = new Map<string, ChatRunEventStream>();
	readonly #observers = new Map<string, Set<ChatEventObserver>>();

	constructor(options: { maxCachedRunStreams?: number } = {}) {
		this.#maxCachedRunStreams = options.maxCachedRunStreams ?? MAX_CACHED_CHAT_RUN_STREAMS;
		if (!Number.isSafeInteger(this.#maxCachedRunStreams) || this.#maxCachedRunStreams <= 0) {
			throw new Error("maxCachedRunStreams must be a positive safe integer");
		}
	}

	publish(runId: string, type: string, data: unknown): void {
		this.#stream(runId).publish(type, data);
		for (const observer of this.#observers.get(type) ?? []) {
			try { observer({ runId, type, data }); }
			catch (error) { reportFailure(error, { stage: "delivery", runId }); }
		}
	}

	/** Low-frequency projections observe selected facts without subscribing to token streams. */
	observe(types: readonly string[], observer: ChatEventObserver): () => void {
		for (const type of types) {
			const observers = this.#observers.get(type) ?? new Set<ChatEventObserver>();
			observers.add(observer);
			this.#observers.set(type, observers);
		}
		return () => {
			for (const type of types) {
				const observers = this.#observers.get(type);
				observers?.delete(observer);
				if (observers?.size === 0) this.#observers.delete(type);
			}
		};
	}

	subscribe(runId: string, lastEventId?: number, locale?: BackendLocale): ReadableStream<Uint8Array> {
		return this.#stream(runId).subscribe(lastEventId, locale);
	}

	close(): void {
		for (const stream of this.#streams.values()) stream.close();
		this.#streams.clear();
		this.#observers.clear();
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
