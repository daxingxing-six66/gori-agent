"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/features/i18n/components/locale-context";
import { apiUrlWithLocale } from "@/shared/api/client";
import { nextWorkspaceEventStreamState } from "../model/sftp-state";
import type {
	ConnectionPoolSnapshot,
	FileTransfer,
	MonitorError,
	RemoteMetricsSnapshot,
	WorkspaceEventStreamState,
} from "../model/sftp";

interface WorkspaceEventHandlers {
	onMetrics?(snapshot: RemoteMetricsSnapshot): void;
	onMonitorError?(error: MonitorError): void;
	onConnection?(snapshot: ConnectionPoolSnapshot): void;
	onTransfer?(transfer: FileTransfer): void;
	onReconnect?(): void;
}

export function useWorkspaceEvents(
	workspaceId: string,
	topics: readonly string[],
	handlers: WorkspaceEventHandlers,
): WorkspaceEventStreamState {
	const { locale } = useLocale();
	const topicKey = topics.join(",");
	const handlersRef = useRef(handlers);
	const [streamState, setStreamState] = useState<WorkspaceEventStreamState>("connecting");
	useEffect(() => {
		handlersRef.current = handlers;
	}, [handlers]);
	useEffect(() => {
		let receivedReady = false;
		const events = new EventSource(apiUrlWithLocale(`/api/workspaces/${encodeURIComponent(workspaceId)}/events?topics=${encodeURIComponent(topicKey)}`, locale));
		const listen = <T,>(name: string, callback: ((value: T) => void) | undefined) => {
			const listener = (event: Event) => {
				try {
					callback?.(JSON.parse((event as MessageEvent<string>).data) as T);
				} catch {
					/* Ignore malformed server events and wait for the next snapshot. */
				}
			};
			events.addEventListener(name, listener);
			return () => events.removeEventListener(name, listener);
		};
		events.onopen = () => setStreamState((current) => nextWorkspaceEventStreamState(current, "open"));
		events.onerror = () => setStreamState((current) => nextWorkspaceEventStreamState(current, "error"));
		const removers = [
			listen<RemoteMetricsSnapshot>("monitor.snapshot", (value) => handlersRef.current.onMetrics?.(value)),
			listen<MonitorError>("monitor.error", (value) => handlersRef.current.onMonitorError?.(value)),
			listen<ConnectionPoolSnapshot>("connection.snapshot", (value) => handlersRef.current.onConnection?.(value)),
			listen<FileTransfer>("transfer.updated", (value) => handlersRef.current.onTransfer?.(value)),
			listen("stream.ready", () => {
				setStreamState((current) => nextWorkspaceEventStreamState(current, "ready"));
				if (receivedReady) handlersRef.current.onReconnect?.();
				receivedReady = true;
			}),
		];
		return () => {
			for (const remove of removers) remove();
			events.close();
		};
	}, [locale, topicKey, workspaceId]);
	return streamState;
}
