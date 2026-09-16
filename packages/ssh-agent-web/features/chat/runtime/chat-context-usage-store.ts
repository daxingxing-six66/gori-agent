import { isChatContextUsage, type ChatContextUsage } from "@/features/chat/model/chat-context-usage";

/** One Session owns each store. Queries can never replace a newer pushed snapshot. */
export class ChatContextUsageStore {
	private value: ChatContextUsage | null = null;
	private revision = 0;
	private controller: AbortController | null = null;
	private readonly listeners = new Set<() => void>();
	private readonly query: (signal: AbortSignal) => Promise<{ contextUsage: ChatContextUsage | null }>;

	constructor(query: (signal: AbortSignal) => Promise<{ contextUsage: ChatContextUsage | null }>) {
		this.query = query;
	}

	getSnapshot = () => this.value;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	apply = (value: ChatContextUsage | null) => {
		this.revision += 1;
		this.value = isChatContextUsage(value) ? value : null;
		for (const listener of this.listeners) listener();
	};
	cancel = () => {
		this.controller?.abort();
		this.controller = null;
	};
	refresh = async () => {
		this.cancel();
		const controller = new AbortController();
		this.controller = controller;
		const revision = this.revision;
		try {
			const result = await this.query(controller.signal);
			if (!controller.signal.aborted && revision === this.revision) this.apply(result.contextUsage);
		} catch {
			// Usage is auxiliary: never block message submission or show stale values as current.
			if (!controller.signal.aborted && revision === this.revision) this.apply(null);
		} finally {
			if (this.controller === controller) this.controller = null;
		}
	};
}
