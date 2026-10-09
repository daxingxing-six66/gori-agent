"use client";

import { AlertCircle } from "lucide-react";
import { useIntl } from "react-intl";
import type { TerminalStatusResponse } from "@/features/terminal/model/terminal";

export interface TerminalOpenFailureInfo {
	key: string | null;
	code: string | null;
	message: string | null;
}

/** The open request can succeed while the background PTY startup later fails. */
export function terminalOpenFailureFromStatus(status: TerminalStatusResponse | null, requestError: string | null): TerminalOpenFailureInfo | null {
	const terminal = status?.terminal;
	if (terminal?.status === "failed") return {
		key: `${terminal.id}:${terminal.updatedAt}`,
		code: terminal.failureCode,
		message: terminal.failureMessage?.trim() || null,
	};
	if (terminal?.status === "active" || status?.transitionInProgress || !requestError) return null;
	return { key: null, code: null, message: requestError };
}

export function TerminalOpenFailure({ failure, canRetry, canRequestInstallation, onRetry, onRequestInstallation, onDismiss }: {
	failure: TerminalOpenFailureInfo;
	canRetry: boolean;
	canRequestInstallation: boolean;
	onRetry(): void;
	onRequestInstallation(): void;
	onDismiss(): void;
}) {
	const intl = useIntl();
	const bubblewrapMissing = failure.code === "sandbox_bubblewrap_not_installed";
	return <section className="terminal-panel grid min-h-[250px] place-items-center overflow-y-auto bg-[var(--terminal-bg)] px-6 py-8 text-[var(--terminal-ink)]" role="alert" aria-live="assertive">
		<div className="w-full max-w-md rounded-2xl border border-[var(--terminal-line-strong)] bg-white/5 p-6 shadow-lg">
			<AlertCircle size={24} className="text-amber-300" aria-hidden="true" />
			<h2 className="mt-4 text-sm font-semibold">{intl.formatMessage({ id: "terminal.openFailure.title" })}</h2>
			<p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--terminal-muted)]">
				{failure.message ?? intl.formatMessage({ id: "terminal.openFailure.unknown" })}
			</p>
			{bubblewrapMissing ? <p className="mt-3 text-xs leading-5 text-[var(--terminal-muted)]">{intl.formatMessage({ id: "terminal.openFailure.bubblewrapHint" })}</p> : null}
			<div className="mt-5 flex flex-wrap gap-2">
				{bubblewrapMissing ? <button type="button" onClick={onRequestInstallation} disabled={!canRequestInstallation}
					className="rounded-lg bg-[var(--terminal-accent)] px-3 py-2 text-xs font-semibold text-[var(--terminal-bg)] disabled:cursor-not-allowed disabled:opacity-40">
					{intl.formatMessage({ id: "terminal.openFailure.install" })}
				</button> : null}
				<button type="button" onClick={onRetry} disabled={!canRetry}
					className="rounded-lg border border-[var(--terminal-line-strong)] px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40">
					{intl.formatMessage({ id: "terminal.openFailure.retry" })}
				</button>
				<button type="button" onClick={onDismiss} className="rounded-lg px-3 py-2 text-xs text-[var(--terminal-muted)]">
					{intl.formatMessage({ id: "terminal.openFailure.dismiss" })}
				</button>
			</div>
			{bubblewrapMissing && !canRequestInstallation ? <p className="mt-3 text-[11px] text-[var(--terminal-muted)]">
				{intl.formatMessage({ id: "terminal.openFailure.selectModel" })}
			</p> : null}
		</div>
	</section>;
}
