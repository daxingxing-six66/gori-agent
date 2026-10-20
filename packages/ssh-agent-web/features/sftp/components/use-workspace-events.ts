"use client";

import { useEffect, useRef, useState } from "react";
import { parseSessionUpdate, type SessionUpdate } from "@/features/workspace/model/session-update";
import { useLocale } from "@/features/i18n/components/locale-context";
import { subscribeWorkspaceEvents } from "@/shared/events/workspace-events";
import { nextWorkspaceEventStreamState } from "../model/sftp-state";
import type {
	ConnectionPoolSnapshot,
	FileTransfer,
	MonitorError,
	RemoteMetricsSnapshot,
	WorkspaceEventStreamState,
} from "../model/sftp";

interface WorkspaceEventHandlers {
	onSession?(session: SessionUpdate): void;
	onReady?(): void;
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
		const events: Record<string, (event: Event) => void> = {};
		const listen = <T,>(name: string, callback: ((value: T) => void) | undefined) => {
			const listener = (event: Event) => {
				try {
					callback?.(JSON.parse((event as MessageEvent<string>).data) as T);
				} catch {
					/* Ignore malformed server events and wait for the next snapshot. */
				}
			};
			events[name] = listener;
		};
		listen<unknown>("session.updated", (value) => {
			const session = parseSessionUpdate(value);
			if (session && session.workspaceId === workspaceId) handlersRef.current.onSession?.(session);
		});
		listen<RemoteMetricsSnapshot>("monitor.snapshot", (value) => handlersRef.current.onMetrics?.(value));
		listen<MonitorError>("monitor.error", (value) => handlersRef.current.onMonitorError?.(value));
		listen<ConnectionPoolSnapshot>("connection.snapshot", (value) => handlersRef.current.onConnection?.(value));
		listen<FileTransfer>("transfer.updated", (value) => handlersRef.current.onTransfer?.(value));
		listen("stream.ready", () => {
			setStreamState((current) => nextWorkspaceEventStreamState(current, "ready"));
			handlersRef.current.onReady?.();
			if (receivedReady) handlersRef.current.onReconnect?.();
			receivedReady = true;
		});
		return subscribeWorkspaceEvents({ workspaceId, locale, topics: topicKey.split(","), events,
			onOpen: () => setStreamState((current) => nextWorkspaceEventStreamState(current, "open")),
			onError: () => setStreamState((current) => nextWorkspaceEventStreamState(current, "error")) });
	}, [locale, topicKey, workspaceId]);
	return streamState;
}
