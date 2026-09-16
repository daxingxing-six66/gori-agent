import type { BackendLocale } from "../i18n/message.ts";
import { localizePublicValue } from "../i18n/projection.ts";
import { CHAT_RUN_STREAM_HEARTBEAT_INTERVAL_MS, MAX_CHAT_RUN_REPLAY_EVENTS } from "./chat-runtime-defaults.ts";
import { reportFailure } from "./failure-reporter.ts";

interface CachedChatEvent {
	readonly id: number;
	readonly type: string;
	readonly data: unknown;
}

interface ChatSubscriber {
	readonly controller: ReadableStreamDefaultController<Uint8Array>;
	readonly locale: BackendLocale;
}

export class ChatRunEventStream {
	private readonly runId: string;
	private sequence = 0;
	private readonly history: CachedChatEvent[] = [];
	private readonly subscribers = new Set<ChatSubscriber>();
	private readonly encoder = new TextEncoder();
	private heartbeat: ReturnType<typeof setInterval> | undefined;

	constructor(runId: string) {
		this.runId = runId;
	}

	publish(type: string, data: unknown): void {
		let snapshot: unknown;
		try {
			snapshot = structuredClone(data);
			JSON.stringify(snapshot);
		} catch (error) {
			reportFailure(error, { stage: "delivery", runId: this.runId });
			snapshot = { eventType: type };
			type = "stream.resync";
		}
		const event = { id: ++this.sequence, type, data: snapshot };
		this.history.push(event);
		if (this.history.length > MAX_CHAT_RUN_REPLAY_EVENTS) this.history.shift();
		this.broadcast(event);
	}

	subscribe(lastEventId = 0, locale: BackendLocale = "zh-CN"): ReadableStream<Uint8Array> {
		let activeSubscriber: ChatSubscriber | undefined;
		return new ReadableStream({
			start: (controller) => {
				activeSubscriber = { controller, locale };
				this.subscribers.add(activeSubscriber);
				this.startHeartbeat();
				controller.enqueue(
					this.encoder.encode(
						`event: stream.ready\ndata: ${JSON.stringify({ runId: this.runId, connectedAt: Date.now() })}\n\n`,
					),
				);
				try {
					for (const event of this.history)
						if (event.id > lastEventId) controller.enqueue(this.encode(event, locale));
				} catch (error) {
					reportFailure(error, { stage: "delivery", runId: this.runId });
					this.subscribers.delete(activeSubscriber);
					if (this.subscribers.size === 0) this.stopHeartbeat();
					controller.error(error);
				}
			},
			cancel: () => {
				if (activeSubscriber) this.subscribers.delete(activeSubscriber);
				if (this.subscribers.size === 0) this.stopHeartbeat();
			},
		});
	}

	close(): void {
		this.stopHeartbeat();
		for (const subscriber of this.subscribers) {
			try {
				subscriber.controller.close();
			} catch {
				/* A disconnected subscriber is already closed. */
			}
		}
		this.subscribers.clear();
	}

	private broadcast(event: CachedChatEvent): void {
		const encoded = new Map<BackendLocale, Uint8Array>();
		for (const locale of new Set([...this.subscribers].map((subscriber) => subscriber.locale))) {
			try {
				encoded.set(locale, this.encode(event, locale));
			} catch (error) {
				reportFailure(error, { stage: "delivery", runId: this.runId });
				encoded.set(
					locale,
					this.encoder.encode(`event: stream.resync\ndata: ${JSON.stringify({ eventType: event.type })}\n\n`),
				);
			}
		}
		for (const subscriber of this.subscribers) {
			const bytes = encoded.get(subscriber.locale);
			if (!bytes) continue;
			try {
				subscriber.controller.enqueue(bytes);
			} catch {
				this.subscribers.delete(subscriber);
			}
		}
		if (this.subscribers.size === 0) this.stopHeartbeat();
	}

	private startHeartbeat(): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => this.broadcastHeartbeat(), CHAT_RUN_STREAM_HEARTBEAT_INTERVAL_MS);
		this.heartbeat.unref();
	}

	private stopHeartbeat(): void {
		if (!this.heartbeat) return;
		clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}

	private broadcastHeartbeat(): void {
		const bytes = this.encoder.encode(": heartbeat\n\n");
		for (const subscriber of this.subscribers) {
			try {
				subscriber.controller.enqueue(bytes);
			} catch {
				this.subscribers.delete(subscriber);
			}
		}
		if (this.subscribers.size === 0) this.stopHeartbeat();
	}

	private encode(event: CachedChatEvent, locale: BackendLocale): Uint8Array {
		return this.encoder.encode(
			`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(localizePublicValue(event.data, locale))}\n\n`,
		);
	}
}
