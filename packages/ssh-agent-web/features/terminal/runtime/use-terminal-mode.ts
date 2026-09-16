"use client";

import { useCallback, useEffect, useState } from "react";
import { terminalApi } from "@/features/terminal/api/terminal-api";
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";
import type { TerminalStatusResponse } from "@/features/terminal/model/terminal";
import { errorMessage } from "@/shared/errors/api-error";

export type TerminalModeTransition = "connecting" | "disconnecting" | "disconnected" | "exiting";

export function useTerminalMode(sessionId: string) {
	const [status, setStatus] = useState<TerminalStatusResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [transition, setTransition] = useState<TerminalModeTransition | null>(null);
	const [error, setError] = useState<string | null>(null);
	const mutating = transition !== null;

	const refresh = useCallback(async (signal?: AbortSignal) => {
		const next = await terminalApi.getStatus(sessionId, signal);
		setStatus(next);
		return next;
	}, [sessionId]);

	useEffect(() => {
		const controller = new AbortController();
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted) return;
			setLoading(true);
			try {
				await refresh(controller.signal);
			} catch (requestError) {
				if (!controller.signal.aborted) setError(errorMessage(requestError));
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		});
		return () => controller.abort();
	}, [refresh]);

	useEffect(() => {
		if (!status?.transitionInProgress) return;
		const timer = setInterval(() => void refresh().catch((requestError) => setError(errorMessage(requestError))), TERMINAL_UI_DEFAULTS.transitionPollMs);
		return () => clearInterval(timer);
	}, [refresh, status?.transitionInProgress]);

	useEffect(() => {
		if (transition !== "disconnected") return;
		const timer = setTimeout(() => setTransition("exiting"), TERMINAL_UI_DEFAULTS.disconnectedNoticeMs);
		return () => clearTimeout(timer);
	}, [transition]);

	useEffect(() => {
		if (transition !== "exiting") return;
		const timer = setTimeout(() => setTransition(null), TERMINAL_UI_DEFAULTS.panelTransitionMs);
		return () => clearTimeout(timer);
	}, [transition]);

	const open = useCallback(async () => {
		if (mutating) return;
		setTransition("connecting");
		setError(null);
		try {
			await terminalApi.open(sessionId, crypto.randomUUID());
			await refresh();
		} catch (requestError) {
			setError(errorMessage(requestError));
		} finally {
			setTransition(null);
		}
	}, [mutating, refresh, sessionId]);

	const close = useCallback(async () => {
		const terminal = status?.terminal;
		if (!terminal || mutating) return;
		setTransition("disconnecting");
		setError(null);
		try {
			await terminalApi.close(sessionId, terminal.id, crypto.randomUUID());
			await refresh();
			setTransition("disconnected");
		} catch (requestError) {
			setError(errorMessage(requestError));
			setTransition(null);
		}
	}, [mutating, refresh, sessionId, status?.terminal]);

	return { status, loading, mutating, transition, error, setError, open, close, refresh };
}
