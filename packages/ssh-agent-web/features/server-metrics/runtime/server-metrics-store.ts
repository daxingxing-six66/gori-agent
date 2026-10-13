import type { SupportedLocale } from "@/features/i18n/model/locale";
import { INITIAL_SERVER_METRICS_STATE, SERVER_METRICS_STALE_MS, type ServerMetricsState } from "../model/server-metrics";
import type { OpenServerMetricsStream } from "./server-metrics-stream";

export interface ServerMetricsResource {
	getSnapshot(): ServerMetricsState;
	subscribe(listener: () => void): () => void;
}

/** One stream per Workspace and locale; sessions share it and a short-lived memory cache. */
export function createServerMetricsStore(openStream: OpenServerMetricsStream) {
	const resources = new Map<string, ServerMetricsResource>();
	return {
		resource(workspaceId: string, locale: SupportedLocale): ServerMetricsResource {
			const key = JSON.stringify([workspaceId, locale]);
			const existing = resources.get(key);
			if (existing) return existing;
			const resource = createResource(workspaceId, locale, openStream, () => {
				if (resources.get(key) === resource) resources.delete(key);
			});
			resources.set(key, resource);
			return resource;
		},
	};
}

function createResource(workspaceId: string, locale: SupportedLocale, openStream: OpenServerMetricsStream,
	onIdle: () => void): ServerMetricsResource {
	let state = INITIAL_SERVER_METRICS_STATE;
	const listeners = new Set<() => void>();
	let closeStream: (() => void) | undefined;
	let freshnessTimer: ReturnType<typeof setInterval> | undefined;
	let evictionTimer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let connected = false;
	let connectionFailed = false;

	const update = (next: ServerMetricsState) => {
		state = next;
		for (const listener of listeners) listener();
	};
	const status = (): ServerMetricsState["status"] => {
		if (state.error !== undefined) return "unavailable";
		if (!connected) return connectionFailed || state.snapshot ? "reconnecting" : "sampling";
		if (!state.snapshot) return "sampling";
		return Date.now() - state.snapshot.sampledAt > SERVER_METRICS_STALE_MS ? "stale" : "live";
	};
	const refreshStatus = () => {
		const nextStatus = status();
		if (state.status !== nextStatus) update({ ...state, status: nextStatus });
	};
	const scheduleEviction = () => { evictionTimer = setTimeout(onIdle, 30_000); };
	// Also bound resources created during server rendering or an abandoned React render.
	scheduleEviction();

	return {
		getSnapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			clearTimeout(evictionTimer);
			if (!closeStream) {
				const currentGeneration = ++generation;
				const current = () => generation === currentGeneration && listeners.size > 0;
				refreshStatus();
				closeStream = openStream({
					workspaceId, locale,
					onSnapshot(snapshot) {
						if (!current() || snapshot.workspaceId !== workspaceId ||
							(state.snapshot && snapshot.sampledAt < state.snapshot.sampledAt)) return;
						state = { snapshot, status: "live" };
						connected = true;
						update({ ...state, status: status() });
					},
					onConnection(value) {
						if (!current()) return;
						connected = value;
						connectionFailed = !value;
						refreshStatus();
					},
					onError(message) {
						if (current()) update({ ...state, status: "unavailable", error: message });
					},
				});
				freshnessTimer = setInterval(refreshStatus, 2_000);
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0) return;
				++generation;
				closeStream?.();
				closeStream = undefined;
				connected = false;
				clearInterval(freshnessTimer);
				state = { ...state, status: state.snapshot ? "stale" : "sampling" };
				scheduleEviction();
			};
		},
	};
}
