import { eventUrl } from "@/shared/events/client";
import { parseActivitySnapshot, parseActivityUpdate } from "../model/session-activity";
import type { SessionActivityStore } from "./session-activity-store";

interface ActivityEventSource {
	addEventListener(type: string, listener: EventListener): void;
	close(): void;
	onerror: EventSource["onerror"];
}

/** Owns connection/recovery only. Business triggers and sidebar components never open streams. */
export class SessionActivityConnection {
	readonly #store: SessionActivityStore;
	readonly #createSource: (url: string) => ActivityEventSource;
	#source?: ActivityEventSource;
	#retry?: ReturnType<typeof setTimeout>;
	#attempt = 0;
	#started = false;

	constructor(store: SessionActivityStore, createSource: (url: string) => ActivityEventSource = (url) => new EventSource(url)) {
		this.#store = store;
		this.#createSource = createSource;
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#connect();
	}

	stop(): void {
		this.#started = false;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#source?.close();
		this.#source = undefined;
		this.#store.disconnect();
	}

	#connect(): void {
		if (!this.#started) return;
		const source = this.#createSource(eventUrl("/api/session-activity/events"));
		this.#source = source;
		let receivedSnapshot = false;
		const listen = (name: string, receive: (value: unknown) => boolean) => {
			source.addEventListener(name, (event) => {
				if (source !== this.#source) return;
				try {
					if (receive(JSON.parse((event as MessageEvent<string>).data))) return;
				} catch { /* Reconnect to a snapshot after malformed or unsupported protocol data. */ }
				this.#recover(source);
			});
		};
		listen("activity.snapshot", (value) => {
			const activities = parseActivitySnapshot(value);
			if (!activities) return false;
			receivedSnapshot = true;
			this.#attempt = 0;
			this.#store.applySnapshot(activities);
			return true;
		});
		listen("activity.updated", (value) => {
			const update = parseActivityUpdate(value);
			if (!receivedSnapshot || !update) return false;
			this.#store.applyUpdate(update);
			return true;
		});
		source.onerror = () => this.#recover(source);
	}

	#recover(source: ActivityEventSource): void {
		if (source !== this.#source || !this.#started) return;
		source.close();
		this.#source = undefined;
		this.#store.disconnect();
		const delay = Math.min(1000 * 2 ** Math.min(this.#attempt++, 5), 30_000);
		this.#retry = setTimeout(() => { this.#retry = undefined; this.#connect(); }, delay);
	}
}
