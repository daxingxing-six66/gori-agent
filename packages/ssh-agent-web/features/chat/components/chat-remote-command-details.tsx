"use client";

import { useIntl } from "react-intl";
import { isRecord } from "@/features/chat/model/chat";
import { ChatCommandDetails, type CommandParameter } from "./chat-command-details";
import { commandParameters } from "./chat-command-parameters";
import type { ToolDetailsProps } from "./chat-tool-details";

export function RemoteCommandDetails({ call, execution, output, failed, children }: ToolDetailsProps) {
	const intl = useIntl();
	const command = call.arguments.command;
	const request = typeof command === "string" ? { label: intl.formatMessage({ id: "chat.tool.command.command" }), value: `$ ${command}`, parameter: "command" } : undefined;
	const details = isRecord(execution?.details) ? execution.details : undefined;
	const outcome: CommandParameter[] = [];
	if (typeof details?.exitCode === "number" && Number.isSafeInteger(details.exitCode)) outcome.push({ label: intl.formatMessage({ id: "chat.tool.command.exitCode" }), value: String(details.exitCode) });
	if (typeof details?.exitSignal === "string") outcome.push({ label: intl.formatMessage({ id: "chat.tool.command.exitSignal" }), value: details.exitSignal });
	return <ChatCommandDetails request={request} parameters={commandParameters(intl, call.arguments, request?.parameter)} outputLabel={intl.formatMessage({ id: "chat.tool.command.output" })} output={output} outcome={outcome} truncated={details?.outputTruncated === true} failed={failed}>{children}</ChatCommandDetails>;
}
