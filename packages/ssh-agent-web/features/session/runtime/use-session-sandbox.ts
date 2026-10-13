"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { ChatComposerTool } from "@/features/chat/model/chat-composer-menu";
import { sessionApi } from "@/features/session/api/session-api";
import type { Session } from "@/features/session/model/session";
import { parseSessionSandboxCommand } from "@/features/session/model/session-sandbox-command";

export function useSessionSandbox(options: {
	sessionId: string;
	session?: Session;
	disabled: boolean;
	refreshSessions(): Promise<unknown>;
	refreshTerminal(signal?: AbortSignal): Promise<unknown>;
}) {
	const intl = useIntl();
	const { sessionId, session, disabled, refreshSessions, refreshTerminal } = options;
	const currentSessionId = useRef(sessionId);
	const mutation = useRef<AbortController | null>(null);
	const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
	const pending = pendingSessionId === sessionId;
	const [confirmed, setConfirmed] = useState<Session | null>(null);
	const [sessionError, setSessionError] = useState<{ sessionId: string; value: unknown } | null>(null);
	const [sessionNotice, setSessionNotice] = useState<{ sessionId: string; value: string } | null>(null);
	const error = sessionError?.sessionId === sessionId ? sessionError.value : null;
	const notice = sessionNotice?.sessionId === sessionId ? sessionNotice.value : null;
	const setError = useCallback((value: unknown) => setSessionError(value === null ? null : { sessionId, value }), [sessionId]);
	const setNotice = useCallback((value: string | null) => setSessionNotice(value === null ? null : { sessionId, value }), [sessionId]);
	const latest = confirmed?.id === sessionId && confirmed.revision >= (session?.revision ?? 0) ? confirmed : session;
	const enabled = latest?.sandboxEnabled !== false;
	const statusLabel = intl.formatMessage({ id: pending ? "session.sandbox.changing" : enabled ? "session.sandbox.on" : "session.sandbox.off" });

	useEffect(() => {
		currentSessionId.current = sessionId;
		mutation.current?.abort();
		mutation.current = null;
		return () => {
			mutation.current?.abort();
			mutation.current = null;
		};
	}, [sessionId]);

	const update = useCallback(async (enabled?: boolean): Promise<boolean> => {
		if (disabled || mutation.current || !session) return false;
		const request = new AbortController();
		mutation.current = request;
		const isCurrent = () => currentSessionId.current === sessionId && mutation.current === request && !request.signal.aborted;
		setPendingSessionId(sessionId);
		setError(null);
		setNotice(null);
		try {
			const current = await sessionApi.get(sessionId, request.signal);
			if (!isCurrent()) return false;
			const sandboxEnabled = enabled ?? current.sandboxEnabled === false;
			const updated = current.sandboxEnabled === sandboxEnabled ? current
				: await sessionApi.update(sessionId, { sandboxEnabled, expectedRevision: current.revision });
			if (!isCurrent()) return false;
			setConfirmed(updated);
			await refreshTerminal(request.signal);
			if (!isCurrent()) return false;
			await refreshSessions();
			return isCurrent();
		} catch (requestError) {
			if (!isCurrent()) return false;
			setError(requestError);
			// The setting may have committed even if reopening the PTY failed.
			const current = await sessionApi.get(sessionId, request.signal).catch(() => null);
			if (!isCurrent()) return false;
			if (current) setConfirmed(current);
			await refreshTerminal(request.signal).catch(() => undefined);
			if (!isCurrent()) return false;
			await refreshSessions().catch(() => undefined);
			return false;
		} finally {
			if (mutation.current === request) {
				mutation.current = null;
				setPendingSessionId(null);
			}
		}
	}, [disabled, refreshSessions, refreshTerminal, session, sessionId, setError, setNotice]);

	const execute = useCallback(async (message: string, hasAttachments = false): Promise<boolean | null> => {
		const command = parseSessionSandboxCommand(message);
		if (!command) return null;
		if (hasAttachments || command.kind === "invalid") {
			setError(new Error(intl.formatMessage({ id: "session.sandbox.usage" })));
			return false;
		}
		if (command.kind === "set") return update(command.enabled);
		if (command.kind === "toggle") return update();
		setError(null);
		setNotice(intl.formatMessage({ id: enabled ? "session.sandbox.enabledDescription" : "session.sandbox.disabledDescription" }));
		return true;
	}, [enabled, intl, update, setError, setNotice]);

	const tools: ChatComposerTool[] = [{
		id: "sandbox", icon: "shield", name: intl.formatMessage({ id: "session.sandbox.command.name" }),
		description: intl.formatMessage({ id: "session.sandbox.command.description" }),
		keywords: ["sandbox", "沙盒", "沙箱"],
		status: { label: statusLabel, tone: pending ? "pending" : enabled ? "active" : "inactive" },
		disabled: disabled || pending || !session,
	}];
	return { enabled, pending, disabled, statusLabel, tools, error, notice, execute,
		clearNotice: () => { setError(null); setNotice(null); } };
}
