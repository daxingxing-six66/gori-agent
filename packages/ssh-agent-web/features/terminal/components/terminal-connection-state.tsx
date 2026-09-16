"use client";

import { CircleCheck, LoaderCircle, PlugZap, Unplug } from "lucide-react";
import { useIntl } from "react-intl";
import type { TerminalModeTransition } from "@/features/terminal/runtime/use-terminal-mode";

export function TerminalConnectionState({ phase }: { phase: TerminalModeTransition }) {
	const intl = useIntl();
	const disconnected = phase === "disconnected" || phase === "exiting";
	const connecting = phase === "connecting";
	const title = intl.formatMessage({ id: connecting ? "terminal.connection.connecting.title" : disconnected ? "terminal.connection.disconnected.title" : "terminal.connection.disconnecting.title" });
	const description = connecting
		? intl.formatMessage({ id: "terminal.connection.connecting.description" })
		: disconnected
			? intl.formatMessage({ id: "terminal.connection.disconnected.description" })
			: intl.formatMessage({ id: "terminal.connection.disconnecting.description" });
	const Icon = connecting ? PlugZap : disconnected ? CircleCheck : Unplug;

	return (
		<section
			className={`terminal-panel terminal-connection-state terminal-connection-state-${phase}`}
			role="status"
			aria-live="polite"
			aria-label={title}
		>
			<div className="terminal-connection-state-content">
				<div className={`terminal-connection-state-icon ${disconnected ? "terminal-connection-state-icon-complete" : ""}`}>
					{disconnected ? <Icon size={20} strokeWidth={1.8} /> : <LoaderCircle className="terminal-connection-spinner" size={36} strokeWidth={1.2} />}
					{disconnected ? null : <Icon className="terminal-connection-symbol" size={16} strokeWidth={1.8} />}
				</div>
				<div>
					<p className="terminal-connection-state-title">{title}</p>
					<p className="terminal-connection-state-description">{description}</p>
				</div>
				<div className={`terminal-connection-state-status ${disconnected ? "terminal-connection-state-status-complete" : ""}`}>
					<span />{intl.formatMessage({ id: disconnected ? "terminal.connection.closed" : connecting ? "terminal.connection.negotiating" : "terminal.connection.cleaning" })}
				</div>
			</div>
		</section>
	);
}
