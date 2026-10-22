"use client";

import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { terminalOpenFailureFromStatus } from "../components/terminal-open-failure";
import type { TerminalPanelPhase } from "../components/terminal-panel";
import type { useTerminalMode } from "./use-terminal-mode";

interface Options {
	sessionId: string;
	mode: ReturnType<typeof useTerminalMode>;
	runActive: boolean;
	submitting: boolean;
	sandboxPending: boolean;
}

/** Terminal owns its lifecycle and projects only the presentation needed by a tab. */
export function useTerminalTask({ sessionId, mode, runActive, submitting, sandboxPending }: Options) {
	const intl = useIntl();
	const session = useMemo(() => ({ sessionId }), [sessionId]);
	const [presentation, setPresentation] = useState<{ session: typeof session; terminalId: string | null;
		dismissedFailure: string | null; phase: TerminalPanelPhase }>({ session, terminalId: null,
		dismissedFailure: null, phase: "attaching" });
	const { open, close, setError, setOpenError } = mode;
	const terminal = mode.status?.terminal;
	const dismissedFailure = presentation.session === session ? presentation.dismissedFailure : null;
	const panelPhase = presentation.session === session && presentation.terminalId === terminal?.id
		? presentation.phase : "attaching";
	const active = terminal?.status === "active";
	const backendTransition = mode.status?.transitionInProgress
		? terminal?.status === "opening" ? "connecting" : "disconnecting" : null;
	const transition = mode.transition ?? backendTransition ?? (sandboxPending && active ? "connecting" : null);
	const failure = terminalOpenFailureFromStatus(mode.status, mode.openError);
	const failureKey = failure ? failure.key ?? mode.openError : null;
	const visibleFailure = transition === null && failure && failureKey !== dismissedFailure ? failure : null;
	const hasError = mode.error !== null && terminal !== null && terminal !== undefined;
	const present = active || transition !== null || visibleFailure !== null || hasError;
	const expanded = present && (transition !== "exiting" || hasError);
	const operationDisabledReason = sandboxPending
		? intl.formatMessage({ id: "session.sandbox.changing" })
		: runActive || submitting ? intl.formatMessage({ id: "terminal.disabled.runActive" })
		: mode.loading ? intl.formatMessage({ id: "terminal.disabled.loading" })
		: transition === "connecting" ? intl.formatMessage({ id: "terminal.disabled.connecting" })
		: transition === "disconnecting" ? intl.formatMessage({ id: "terminal.disabled.disconnecting" })
		: transition !== null ? intl.formatMessage({ id: "terminal.disabled.exiting" })
		: mode.status === null ? intl.formatMessage({ id: "terminal.disabled.unavailable" }) : undefined;

	const dismiss = useCallback(() => {
		setPresentation((current) => ({ ...current, session, dismissedFailure: failureKey }));
		setOpenError(null);
		setError(null);
	}, [failureKey, session, setError, setOpenError]);
	const retry = useCallback(() => {
		if (operationDisabledReason !== undefined) return;
		setPresentation((current) => ({ ...current, session, dismissedFailure: null }));
		void open();
	}, [open, operationDisabledReason, session]);
	const requestClose = useCallback(() => {
		if (operationDisabledReason !== undefined) return;
		if (active) void close();
		else dismiss();
	}, [active, close, dismiss, operationDisabledReason]);
	const reveal = useCallback(() => {
		// An existing page is a navigation target, including while Agent or PTY work is busy.
		if (!present && operationDisabledReason === undefined) retry();
	}, [operationDisabledReason, present, retry]);
	const onPanelPhaseChange = useCallback((phase: TerminalPanelPhase) => {
		setPresentation((current) => ({ session, terminalId: terminal?.id ?? null, phase,
			dismissedFailure: current.session === session ? current.dismissedFailure : null }));
	}, [session, terminal?.id]);

	const label = mode.loading ? intl.formatMessage({ id: "terminal.status.detecting" })
		: mode.status === null ? intl.formatMessage({ id: "terminal.status.unavailable" })
		: transition === "connecting" ? intl.formatMessage({ id: "terminal.status.starting" })
		: transition !== null ? intl.formatMessage({ id: "terminal.status.closing" })
		: visibleFailure ? intl.formatMessage({ id: "terminal.tab.failed" })
		: active ? intl.formatMessage({ id: panelPhase === "live" ? "terminal.panel.live"
			: panelPhase === "replaying" ? "terminal.panel.replaying" : "terminal.panel.attaching" })
		: intl.formatMessage({ id: "terminal.status.stopped" });
	const tone = visibleFailure || mode.error ? "danger" as const
		: transition !== null || (active && panelPhase !== "live") ? "warning" as const
		: active ? "positive" as const : "neutral" as const;

	return { active, present, expanded, transition, failure: visibleFailure, label, tone, inputBusy: runActive || submitting || sandboxPending,
		operationDisabledReason, menuDisabledReason: present ? undefined : operationDisabledReason,
		reveal, retry, dismiss, requestClose, onPanelPhaseChange };
}
