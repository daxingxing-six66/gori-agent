"use client";

import { useIntl, type IntlShape } from "react-intl";
import { isRecord } from "@/features/chat/model/chat";
import { ChatCommandDetails, type CommandRequest } from "./chat-command-details";
import { commandParameters } from "./chat-command-parameters";
import type { ToolDetailsProps } from "./chat-tool-details";

type TerminalRequestPresenter = (args: Record<string, unknown>, intl: IntlShape) => CommandRequest | undefined;

const terminalRequests: Record<string, TerminalRequestPresenter> = {
	submit: (args, intl) => typeof args.input === "string" ? { label: intl.formatMessage({ id: "chat.tool.command.input" }), value: args.input, parameter: "input" } : undefined,
	key: (args, intl) => typeof args.key === "string" ? { label: intl.formatMessage({ id: "chat.tool.command.shortcut" }), value: args.key === "CTRL_C" ? "Ctrl+C" : args.key, parameter: "key" } : undefined,
	observe: () => undefined,
};

export function TerminalInteractionDetails({ call, execution, output, failed, children }: ToolDetailsProps) {
	const intl = useIntl();
	const action = call.arguments.action;
	const presenter = typeof action === "string" && Object.hasOwn(terminalRequests, action) ? terminalRequests[action] : undefined;
	const request = presenter?.(call.arguments, intl);
	const details = isRecord(execution?.details) ? execution.details : undefined;
	const visibleArguments = Object.fromEntries(Object.entries(call.arguments).filter(([key]) => key !== "action" && key !== "expectation"));
	return <ChatCommandDetails request={request} parameters={commandParameters(intl, visibleArguments, request?.parameter)} outputLabel={intl.formatMessage({ id: "chat.tool.command.terminalOutput" })} output={output} truncated={details?.truncated === true} failed={failed}>{children}</ChatCommandDetails>;
}
