import { isRecord, type ChatToolExecution, type ToolCallContent } from "./chat";

/** A transfer preview refers to the local file, never a guessed remote destination or directory. */
export function toolPreviewFile(call: ToolCallContent, execution?: ChatToolExecution): string | undefined {
	if (execution?.status !== "completed" || execution.isError) return undefined;
	let path: unknown;
	if (call.name === "read" || call.name === "write") path = call.arguments.path ?? call.arguments.file_path;
	if (call.name === "sftp_upload" || call.name === "sftp_download") {
		const details = isRecord(execution.details) ? execution.details : undefined;
		if (details?.status !== "completed") return undefined;
		path = call.name === "sftp_upload" ? details.sourceFilePath : details.localPath;
	}
	return typeof path === "string" && path.trim() ? path : undefined;
}
