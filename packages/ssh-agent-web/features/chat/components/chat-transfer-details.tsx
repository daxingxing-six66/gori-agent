"use client";

import { useIntl } from "react-intl";
import { isRecord, type ChatToolExecution, type ToolUpdate } from "@/features/chat/model/chat";
import type { MessageId } from "@/features/i18n/messages/zh-CN";
import type { ToolDetailsProps } from "./chat-tool-details";

interface TransferFields { source: string; target: string; sourceLabel: MessageId; fileLabel: MessageId; directoryLabel: MessageId; className: string; }

export function DownloadToolDetails(props: ToolDetailsProps) {
	return <TransferDetails {...props} fields={{ source: "remoteFilePath", target: "localPath", sourceLabel: "chat.tool.download.remotePath", fileLabel: "chat.tool.download.localPath", directoryLabel: "chat.tool.download.localDirectory", className: "chat-download-paths" }} />;
}

export function UploadToolDetails(props: ToolDetailsProps) {
	return <TransferDetails {...props} fields={{ source: "sourceFilePath", target: "remotePath", sourceLabel: "chat.tool.upload.sourcePath", fileLabel: "chat.tool.upload.remotePath", directoryLabel: "chat.tool.upload.remoteDirectory", className: "chat-upload-paths" }} />;
}

function TransferDetails({ call, execution, output, failed, children, fields }: ToolDetailsProps & { fields: TransferFields }) {
	const intl = useIntl();
	const details = isRecord(execution?.details) ? execution.details : undefined;
	const sourceResult = details?.[fields.source];
	const sourceArgument = call.arguments[fields.source];
	const sourcePath = typeof sourceResult === "string" ? sourceResult : typeof sourceArgument === "string" ? sourceArgument : undefined;
	const targetResult = details?.[fields.target];
	const targetFile = typeof targetResult === "string" ? targetResult : undefined;
	const targetPath = targetFile ?? (typeof call.arguments.targetPath === "string" ? call.arguments.targetPath : undefined);
	const waiting = intl.formatMessage({ id: "chat.tool.target.waiting" });
	return <>
		<dl className={`chat-transfer-paths ${fields.className} mt-3 mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs leading-5`}>
			<dt className="whitespace-nowrap text-muted">{intl.formatMessage({ id: fields.sourceLabel })}</dt>
			<dd className="min-w-0 whitespace-pre-wrap break-all font-mono text-ink" title={sourcePath}>{sourcePath ?? waiting}</dd>
			<dt className="whitespace-nowrap text-muted">{intl.formatMessage({ id: targetFile === undefined ? fields.directoryLabel : fields.fileLabel })}</dt>
			<dd className="min-w-0 whitespace-pre-wrap break-all font-mono text-ink" title={targetPath}>{targetPath ?? waiting}</dd>
		</dl>
		{children}
		{output && failed ? <pre className="app-scrollbar mt-3 max-h-64 overflow-auto border-t border-line-soft pt-3 font-mono text-[11px] leading-5 text-danger">{output}</pre> : null}
	</>;
}

export function transferProgress(execution: ChatToolExecution | undefined, details: Record<string, unknown> | undefined): ToolUpdate | undefined {
	if (execution?.status !== "running" && details && (details.status === "completed" || details.status === "failed" || details.status === "cancelled" || details.status === "uncertain")) {
		const current = details.bytesTransferred;
		const total = details.totalBytes;
		if (typeof current === "number" && Number.isSafeInteger(current) && current >= 0 &&
			typeof total === "number" && Number.isSafeInteger(total) && total >= current &&
			(details.status !== "completed" || current === total)) {
			return { type: "progress", detail: { current, total, unit: "bytes" } };
		}
	}
	return execution?.latestUpdate;
}
