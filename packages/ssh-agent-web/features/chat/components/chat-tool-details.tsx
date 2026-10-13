import type { ComponentType, ReactNode } from "react";
import { isRecord, type ChatToolExecution, type ToolCallContent, type ToolUpdate } from "@/features/chat/model/chat";
import type { MessageId } from "@/features/i18n/messages/zh-CN";
import { toolResultText } from "@/features/chat/model/chat-runtime-state";
import { RemoteCommandDetails } from "./chat-remote-command-details";
import { TerminalInteractionDetails } from "./chat-terminal-interaction-details";
import { DownloadToolDetails, UploadToolDetails, transferProgress } from "./chat-transfer-details";

export interface ToolDetailsProps {
	call: ToolCallContent;
	execution?: ChatToolExecution;
	argumentsText: string;
	output: string;
	failed: boolean;
	children?: ReactNode;
}

interface ToolDetailsPresentation {
	Component: ComponentType<ToolDetailsProps>;
	className: string;
	headerClassName: string;
	progressLabel?: MessageId;
	update(execution?: ChatToolExecution): ToolUpdate | undefined;
	result(execution?: ChatToolExecution): string;
}

function GenericToolDetails({ argumentsText, output, failed, children }: ToolDetailsProps) {
	return <>
		<pre className="app-scrollbar mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ink">{argumentsText}</pre>
		{children}
		{output ? <pre className={`app-scrollbar mt-3 max-h-64 overflow-auto border-t border-line-soft pt-3 font-mono text-[11px] leading-5 ${failed ? "text-danger" : "text-secondary"}`}>{output}</pre> : null}
	</>;
}

const generic: ToolDetailsPresentation = {
	Component: GenericToolDetails, className: "", headerClassName: "", update: (execution) => execution?.latestUpdate,
	result: (execution) => toolResultText(execution?.result ?? (execution?.latestUpdate?.type === "text" ? execution.latestUpdate.detail.content : undefined)),
};
const command = { ...generic, className: "chat-command-card", headerClassName: "chat-command-header", result: (execution?: ChatToolExecution) =>
	isRecord(execution?.result) && Array.isArray(execution.result.content) ? toolResultText(execution.result.content) : generic.result(execution),
};
const transfer = { ...generic, update: (execution?: ChatToolExecution) => transferProgress(execution, isRecord(execution?.details) ? execution.details : undefined) };
const presentations: Record<string, ToolDetailsPresentation> = {
	remote_server_call: { ...command, Component: RemoteCommandDetails },
	terminal_interaction: { ...command, Component: TerminalInteractionDetails },
	sftp_download: { ...transfer, Component: DownloadToolDetails, progressLabel: "chat.tool.download.progress" },
	sftp_upload: { ...transfer, Component: UploadToolDetails, progressLabel: "chat.tool.upload.progress" },
};

export function toolDetailsPresentation(name: string): ToolDetailsPresentation {
	return Object.hasOwn(presentations, name) ? presentations[name] : generic;
}
