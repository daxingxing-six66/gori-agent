import type { SupportedLocale } from "@/features/i18n/model/locale";
import { subscribeWorkspaceEvents } from "@/shared/events/workspace-events";
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
	const onSnapshot = (event: Event) => {
		if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
		const snapshot = parseServerMetricsSnapshot(readJson(event.data));
		if (snapshot?.workspaceId === options.workspaceId) options.onSnapshot(snapshot);
	};
	const onError = (event: Event) => {
		if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
		const value = readJson(event.data);
		if (value !== null && typeof value === "object" && "message" in value && typeof value.message === "string") {
			options.onError(value.message);
		}
	};
	return subscribeWorkspaceEvents({ workspaceId: options.workspaceId, locale: options.locale, topics: ["monitoring"],
		events: { "monitor.snapshot": onSnapshot, "monitor.error": onError },
		onOpen: () => options.onConnection(true), onError: () => options.onConnection(false) });
};

function readJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}
