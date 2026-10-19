import type { SupportedLocale } from "@/features/i18n/model/locale";
import { eventUrlWithLocale } from "@/shared/events/client";
import { parseServerMetricsSnapshot, type ServerMetricsSnapshot } from "../model/server-metrics";

export interface ServerMetricsStreamOptions {
	workspaceId: string;
	locale: SupportedLocale;
	onSnapshot(snapshot: ServerMetricsSnapshot): void;
	onConnection(connected: boolean): void;
	onError(message: string): void;
}

export type OpenServerMetricsStream = (options: ServerMetricsStreamOptions) => () => void;

export const openServerMetricsStream: OpenServerMetricsStream = (options) => {
	const path = `/api/workspaces/${encodeURIComponent(options.workspaceId)}/events?topics=monitoring`;
	const events = new EventSource(eventUrlWithLocale(path, options.locale));
	const onSnapshot = (event: MessageEvent<string>) => {
		const snapshot = parseServerMetricsSnapshot(readJson(event.data));
		if (snapshot?.workspaceId === options.workspaceId) options.onSnapshot(snapshot);
	};
	const onError = (event: MessageEvent<string>) => {
		const value = readJson(event.data);
		if (value !== null && typeof value === "object" && "message" in value && typeof value.message === "string") {
			options.onError(value.message);
		}
	};
	events.addEventListener("monitor.snapshot", onSnapshot);
	events.addEventListener("monitor.error", onError);
	events.onopen = () => options.onConnection(true);
	events.onerror = () => options.onConnection(false);
	return () => {
		events.onopen = null;
		events.onerror = null;
		events.removeEventListener("monitor.snapshot", onSnapshot);
		events.removeEventListener("monitor.error", onError);
		events.close();
	};
};

function readJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}
