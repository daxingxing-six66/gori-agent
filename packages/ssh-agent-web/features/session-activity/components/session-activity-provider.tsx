"use client";

import { useParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { SessionActivityDisplayState } from "../model/session-activity";
import { SessionActivityConnection } from "../runtime/session-activity-connection";
import { SessionActivityStore } from "../runtime/session-activity-store";
import { createBrowserActivityReadState } from "../runtime/session-activity-read-state";

const ActivityContext = createContext<SessionActivityStore | null>(null);
const serverState = (): SessionActivityDisplayState => "unknown";

export function SessionActivityProvider({ children }: { children: React.ReactNode }) {
	const [store] = useState(() => new SessionActivityStore(createBrowserActivityReadState()));
	const { sessionId } = useParams<{ sessionId?: string }>() ?? {};
	useEffect(() => {
		const updateViewedSession = () => store.setViewedSession(document.visibilityState === "visible" ? sessionId ?? null : null);
		updateViewedSession();
		document.addEventListener("visibilitychange", updateViewedSession);
		return () => {
			document.removeEventListener("visibilitychange", updateViewedSession);
			store.setViewedSession(null);
		};
	}, [store, sessionId]);
	useEffect(() => {
		const connection = new SessionActivityConnection(store);
		connection.start();
		return () => connection.stop();
	}, [store]);
	return <ActivityContext.Provider value={store}>{children}</ActivityContext.Provider>;
}

export function useSessionActivity(sessionId: string): SessionActivityDisplayState {
	const store = useContext(ActivityContext);
	const subscribe = useCallback((listener: () => void) => store?.subscribe(sessionId, listener) ?? (() => {}), [store, sessionId]);
	return useSyncExternalStore(subscribe, () => store?.state(sessionId) ?? "idle", serverState);
}

export function useAcknowledgeSessionActivity(sessionId: string): () => void {
	const store = useContext(ActivityContext);
	return useCallback(() => store?.acknowledge(sessionId), [store, sessionId]);
}
