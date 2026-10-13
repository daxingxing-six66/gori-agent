"use client";

import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import "./chat-command-details.css";

export interface CommandParameter { label: string; value: string; }
export interface CommandRequest { label: string; value: string; parameter: string; }

export function ChatCommandDetails({ request, parameters, outputLabel, output, outcome = [], truncated, failed, children }: {
	request?: CommandRequest;
	parameters: CommandParameter[];
	outputLabel: string;
	output: string;
	outcome?: CommandParameter[];
	truncated: boolean;
	failed: boolean;
	children?: ReactNode;
}) {
	const intl = useIntl();
	return <>
		{request ? <section className="chat-command-request">
			<p className="chat-command-label">{request.label}</p>
			<pre className="app-scrollbar"><code>{request.value}</code></pre>
		</section> : null}
		{parameters.length > 0 ? <dl className="chat-command-parameters">
			{parameters.map((entry, index) => <div key={index}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}
		</dl> : null}
		{children}
		{output || outcome.length > 0 || truncated ? <section className="chat-command-output">
			<div className="chat-command-output-heading">
				<p className="chat-command-label">{outputLabel}</p>
				<dl className="chat-command-outcome">{outcome.map((entry, index) => <div key={index}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>
				{truncated ? <span className="chat-command-truncated">{intl.formatMessage({ id: "chat.tool.command.truncated" })}</span> : null}
			</div>
			{output ? <pre className={`app-scrollbar ${failed ? "text-danger" : "text-secondary"}`}>{output}</pre> : null}
		</section> : null}
	</>;
}
