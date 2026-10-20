import type { SupportedLocale } from "@/features/i18n/model/locale";
import { eventUrlWithLocale } from "./client";

interface WorkspaceSubscription {
	workspaceId: string;
	locale: SupportedLocale;
	topics: readonly string[];
	events: Readonly<Record<string, (event: Event) => void>>;
	onOpen?(): void;
	onError?(): void;
}

const connections = new Map<string, WorkspaceConnection>();

/** Share one Workspace transport; each feature still validates and reconciles its own events. */
export function subscribeWorkspaceEvents(subscription: WorkspaceSubscription): () => void {
	const key = JSON.stringify([subscription.workspaceId, subscription.locale]);
	let connection = connections.get(key);
	if (!connection) {
		connection = new WorkspaceConnection(subscription.workspaceId, subscription.locale);
		connections.set(key, connection);
	}
	const current = connection;
	const remove = current.add(subscription);
	return () => {
		remove();
		if (current.empty && connections.get(key) === current) connections.delete(key);
	};
}

class WorkspaceConnection {
	private readonly subscribers = new Set<WorkspaceSubscription>();
	private readonly workspaceId: string;
	private readonly locale: SupportedLocale;
	private source?: EventSource;
	private topics = "";
	private scheduled = false;
	private registered = new Set<string>();
	private ready?: Event;
	private connected = false;

	constructor(workspaceId: string, locale: SupportedLocale) { this.workspaceId = workspaceId; this.locale = locale; }
	get empty(): boolean { return this.subscribers.size === 0; }

	add(subscription: WorkspaceSubscription): () => void {
		this.subscribers.add(subscription);
		this.schedule();
		const source = this.source;
		const ready = this.ready;
		queueMicrotask(() => {
			if (!source || source !== this.source || !this.subscribers.has(subscription)) return;
			if (this.connected) deliver(() => subscription.onOpen?.());
			if (ready && ready === this.ready) deliver(() => subscription.events["stream.ready"]?.(ready));
		});
		return () => {
			if (!this.subscribers.delete(subscription)) return;
			if (this.empty) this.disconnect();
			else this.schedule();
		};
	}

	private schedule(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => { this.scheduled = false; this.synchronize(); });
	}

	private synchronize(): void {
		if (this.empty) return;
		const topics = [...new Set([...this.subscribers].flatMap((subscriber) => [...subscriber.topics]))].sort().join(",");
		if (!this.source || this.topics !== topics) {
			this.disconnect();
			this.topics = topics;
			const query = new URLSearchParams({ topics });
			const source = new EventSource(eventUrlWithLocale(`/api/workspaces/${encodeURIComponent(this.workspaceId)}/events?${query}`, this.locale));
			this.source = source;
			source.onopen = () => {
				if (source !== this.source) return;
				this.connected = true;
				for (const subscriber of this.subscribers) deliver(() => subscriber.onOpen?.());
			};
			source.onerror = () => {
				if (source !== this.source) return;
				this.connected = false; this.ready = undefined;
				for (const subscriber of this.subscribers) deliver(() => subscriber.onError?.());
			};
		}
		const source = this.source;
		for (const type of new Set(["stream.ready", ...[...this.subscribers].flatMap((subscriber) => Object.keys(subscriber.events))])) {
			if (this.registered.has(type)) continue;
			this.registered.add(type);
			source.addEventListener(type, (event) => {
				if (source !== this.source) return;
				if (type === "stream.ready") this.ready = event;
				for (const subscriber of this.subscribers) deliver(() => subscriber.events[type]?.(event));
			});
		}
	}

	private disconnect(): void {
		if (this.source) {
			this.source.onopen = null; this.source.onerror = null; this.source.close();
			this.source = undefined;
		}
		this.connected = false; this.ready = undefined; this.registered.clear();
	}
}

function deliver(callback: () => void): void {
	try { callback(); } catch (error) { console.error("Workspace event subscriber failed", error); }
}
