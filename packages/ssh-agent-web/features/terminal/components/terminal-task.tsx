"use client";

import { useIntl } from "react-intl";
import { TerminalConnectionState } from "./terminal-connection-state";
import { TerminalOpenFailure } from "./terminal-open-failure";
import { TerminalPanel } from "./terminal-panel";
import type { useTerminalMode } from "../runtime/use-terminal-mode";
import type { useTerminalTask } from "../runtime/use-terminal-task";
import "./terminal-task.css";

interface Props {
	sessionId: string;
	mode: ReturnType<typeof useTerminalMode>;
	task: ReturnType<typeof useTerminalTask>;
	canRequestInstallation: boolean;
	onRequestInstallation(): void;
}

/** All Terminal-specific content stays inside the feature, including transitional pages. */
export function TerminalTask({ sessionId, mode, task, canRequestInstallation, onRequestInstallation }: Props) {
	const intl = useIntl();
	return <div className="terminal-task-surface">
		{mode.error ? <div className="terminal-task-error" role="alert">
			<span>{mode.error}</span>
			<button type="button" onClick={() => mode.setError(null)} aria-label={intl.formatMessage({ id: "terminal.openFailure.dismiss" })}>×</button>
		</div> : null}
		{task.transition ? <TerminalConnectionState phase={task.transition} />
			: task.failure ? <TerminalOpenFailure failure={task.failure}
				canRetry={task.operationDisabledReason === undefined} canRequestInstallation={canRequestInstallation}
				onRetry={task.retry} onDismiss={task.dismiss} onRequestInstallation={onRequestInstallation} />
			: task.active && mode.status ? <TerminalPanel sessionId={sessionId} status={mode.status}
				inputBusy={task.inputBusy}
				onTerminalStateChange={mode.refresh} onPhaseChange={task.onPanelPhaseChange} /> : null}
	</div>;
}
