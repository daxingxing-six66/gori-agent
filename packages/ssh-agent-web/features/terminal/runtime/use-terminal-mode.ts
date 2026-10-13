"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { terminalApi } from "@/features/terminal/api/terminal-api";
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";
import type { TerminalStatusResponse } from "@/features/terminal/model/terminal";
import { errorMessage } from "@/shared/errors/api-error";

export type TerminalModeTransition = "connecting" | "disconnecting" | "disconnected" | "exiting";

interface TerminalModeState {
	status: TerminalStatusResponse | null;
	loading: boolean;
	transition: TerminalModeTransition | null;
	error: string | null;
	openError: string | null;
	requestPending: boolean;
}

interface TerminalModeScope {
	session: { sessionId: string };
	active: boolean;
	state: TerminalModeState;
	operation: "open" | "close" | null;
	readSequence: number;
	closingTerminalId: string | null;
}

const initialState: TerminalModeState = { status: null, loading: true, transition: null, error: null,
	openError: null, requestPending: false };

function hasLiveTerminal(status: TerminalStatusResponse | null): boolean {
	const state = status?.terminal?.status;
	return state === "active" || state === "opening" || state === "closing";
}

function confirmsClosed(status: TerminalStatusResponse, terminalId: string): boolean {
	const terminal = status.terminal;
	return terminal === null || (terminal.id === terminalId && !hasLiveTerminal(status));
}

export function useTerminalMode(sessionId: string) {
	const session = useMemo(() => ({ sessionId }), [sessionId]);
	const scopeRef = useRef<TerminalModeScope | null>(null);
	const [snapshot, setSnapshot] = useState({ session, state: initialState });
	// A new identity hides the previous Session before effects clean up.
	const state = snapshot.session === session ? snapshot.state : initialState;
	const { status, loading, transition, error, openError } = state;
	const currentScope = useCallback(() => {
		const scope = scopeRef.current;
		return scope?.active && scope.session === session ? scope : null;
	}, [session]);
	const update = useCallback((change: Partial<TerminalModeState>) => {
		const scope = currentScope();
		if (!scope) return;
		scope.state = { ...scope.state, ...change };
		setSnapshot({ session, state: scope.state });
	}, [currentScope, session]);
	const setError = useCallback((value: SetStateAction<string | null>) => {
		const scope = currentScope();
		if (scope) update({ error: typeof value === "function" ? value(scope.state.error) : value });
	}, [currentScope, update]);
	const setOpenError = useCallback((value: SetStateAction<string | null>) => {
		const scope = currentScope();
		if (scope) update({ openError: typeof value === "function" ? value(scope.state.openError) : value });
	}, [currentScope, update]);

	const refresh = useCallback(async (signal?: AbortSignal) => {
		const scope = currentScope();
		if (!scope) throw new DOMException("Terminal Session is no longer visible", "AbortError");
		const sequence = ++scope.readSequence;
		const next = await terminalApi.getStatus(sessionId, signal);
		if (!signal?.aborted && currentScope() === scope && sequence === scope.readSequence) {
			if (scope.closingTerminalId && confirmsClosed(next, scope.closingTerminalId)) {
				scope.closingTerminalId = null;
				update({ status: next, transition: "disconnected" });
			} else update({ status: next });
		}
		return next;
	}, [currentScope, sessionId, update]);

	useEffect(() => {
		const scope: TerminalModeScope = { session, active: true, state: initialState, operation: null,
			readSequence: 0, closingTerminalId: null };
		scopeRef.current = scope;
		const controller = new AbortController();
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted || currentScope() !== scope) return;
			try {
				await refresh(controller.signal);
			} catch (requestError) {
				if (!controller.signal.aborted) update({ error: errorMessage(requestError) });
			} finally {
				if (!controller.signal.aborted) update({ loading: false });
			}
		});
		return () => { scope.active = false; controller.abort(); };
	}, [currentScope, refresh, session, update]);

	useEffect(() => {
		if (!status?.transitionInProgress) return;
		const controller = new AbortController();
		let polling = false;
		const timer = setInterval(() => {
			if (polling) return;
			polling = true;
			void refresh(controller.signal).catch((requestError) => {
				if (!controller.signal.aborted) update({ error: errorMessage(requestError) });
			}).finally(() => { polling = false; });
		}, TERMINAL_UI_DEFAULTS.transitionPollMs);
		return () => { controller.abort(); clearInterval(timer); };
	}, [refresh, status?.transitionInProgress, update]);

	useEffect(() => {
		if (transition !== "disconnected") return;
		const timer = setTimeout(() => update({ transition: "exiting" }), TERMINAL_UI_DEFAULTS.disconnectedNoticeMs);
		return () => clearTimeout(timer);
	}, [transition, update]);

	useEffect(() => {
		if (transition !== "exiting") return;
		const timer = setTimeout(() => update({ transition: null }), TERMINAL_UI_DEFAULTS.panelTransitionMs);
		return () => clearTimeout(timer);
	}, [transition, update]);

	const mutationScope = useCallback(() => {
		const scope = currentScope();
		return scope && !scope.operation && !scope.state.loading && scope.state.transition === null &&
			scope.state.status !== null && !scope.state.status.transitionInProgress ? scope : null;
	}, [currentScope]);
	const open = useCallback(async (): Promise<void> => {
		const scope = mutationScope();
		if (!scope || hasLiveTerminal(scope.state.status)) return;
		scope.operation = "open";
		++scope.readSequence;
		update({ transition: "connecting", error: null, openError: null, requestPending: true });
		try {
			await terminalApi.open(sessionId, crypto.randomUUID());
			if (currentScope() === scope) await refresh();
		} catch (requestError) {
			if (currentScope() !== scope) return;
			update({ openError: errorMessage(requestError) });
			// The POST may have committed even when its response was lost.
			await refresh().catch(() => undefined);
			if (currentScope() === scope && hasLiveTerminal(scope.state.status)) update({ openError: null });
		} finally {
			if (currentScope() === scope) {
				scope.operation = null;
				update({ transition: null, requestPending: false });
			}
		}
	}, [currentScope, mutationScope, refresh, sessionId, update]);

	const close = useCallback(async (): Promise<void> => {
		const scope = mutationScope();
		const terminal = scope?.state.status?.terminal;
		if (!scope || !terminal || !hasLiveTerminal(scope.state.status)) return;
		scope.operation = "close";
		scope.closingTerminalId = terminal.id;
		++scope.readSequence;
		update({ transition: "disconnecting", error: null, requestPending: true });
		try {
			await terminalApi.close(sessionId, terminal.id, crypto.randomUUID());
			if (currentScope() === scope) await refresh();
		} catch (requestError) {
			if (currentScope() !== scope) return;
			update({ error: errorMessage(requestError) });
			await refresh().catch(() => undefined);
		} finally {
			if (currentScope() === scope) {
				scope.operation = null;
				// Only a confirmed terminal state completes the close animation.
				if (scope.closingTerminalId && scope.state.status?.terminal?.status !== "closing") {
					scope.closingTerminalId = null;
					update({ transition: null, requestPending: false });
				} else update({ requestPending: false });
			}
		}
	}, [currentScope, mutationScope, refresh, sessionId, update]);

	const mutating = transition !== null || state.requestPending;
	return { status, loading, mutating, transition, error, openError, setError, setOpenError, open, close, refresh };
}
