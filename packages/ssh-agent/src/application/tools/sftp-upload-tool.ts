import { open } from "node:fs/promises";
import { basename, posix } from "node:path";
import {
	AgentRunError,
	type AgentTool,
	AgentToolError,
	type ExecutionEnv,
	getOrThrow,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { FileTransferError, type SftpDirectoryEntry } from "../../domain/file-transfer.ts";
import type { SessionId } from "../../domain/ids.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import { backendMessage } from "../../i18n/message.ts";
import type { SshTargetResolver } from "../services/ssh-target-resolver.ts";
import type { SftpFileBroker } from "../ssh-channel-broker.ts";
import {
	progressToolUpdate,
	statusToolUpdate,
	type ToolUpdate,
	type ToolUpdateDetails,
	textToolUpdate,
} from "../tool-update-protocol.ts";

const PROGRESS_BYTES_INTERVAL = 256 * 1024;
const PROGRESS_TIME_INTERVAL_MS = 200;

const sftpUploadParameters = Type.Object({
	sourceFilePath: Type.String({
		minLength: 1,
		description: "Local file path, relative to the Session working directory or absolute",
	}),
	targetPath: Type.String({
		minLength: 1,
		description: "Absolute directory path on the remote server",
	}),
});

export type SftpUploadParameters = Static<typeof sftpUploadParameters>;

export type SftpUploadStatus =
	| "checking"
	| "awaiting_approval"
	| "uploading"
	| "completed"
	| "failed"
	| "cancelled"
	| "uncertain";

export interface SftpUploadDetails extends ToolUpdateDetails {
	status: SftpUploadStatus;
	sourceFilePath: string;
	remotePath?: string;
	totalBytes?: number;
	bytesTransferred?: number;
	progressPercent?: number;
	overwrite?: boolean;
	existingEntry?: SftpDirectoryEntry;
}

export type SftpOverwriteApprovalDecision =
	| { approved: true }
	| { approved: false; reason: "user_rejected" | "timeout" | "run_cancelled" | "server_restarted" };

export type RequestSftpOverwriteApproval = (
	toolCallId: string,
	existingEntry: SftpDirectoryEntry,
	signal: AbortSignal,
) => Promise<SftpOverwriteApprovalDecision>;

export const sftpUploadDefinition = {
	name: "sftp_upload",
	label: "SFTP file upload",
	description:
		"Upload one local file to a directory on the current remote SSH server. The target path must be an absolute remote directory. The local file name is preserved.",
	parameters: sftpUploadParameters,
};

export function createSftpUploadTool(options: {
	sessionId: SessionId;
	env: Pick<ExecutionEnv, "absolutePath" | "fileInfo">;
	targets: SshTargetResolver;
	broker: SftpFileBroker;
	requestOverwriteApproval: RequestSftpOverwriteApproval;
}): AgentTool<typeof sftpUploadParameters, SftpUploadDetails> {
	return {
		...sftpUploadDefinition,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeSignal = signal ?? new AbortController().signal;
			let sourceFilePath = params.sourceFilePath;
			let remotePath: string | undefined;
			let totalBytes: number | undefined;
			let bytesTransferred = 0;
			let overwrite = false;
			const update = (
				details: SftpUploadDetails,
				text: string,
				transportUpdate: ToolUpdate = textToolUpdate(text),
			) => onUpdate?.({ content: [{ type: "text", text }], details: { ...details, update: transportUpdate } });

			try {
				throwIfAborted(activeSignal);
				const checkingMessage = `Checking local file: ${sourceFilePath}`;
				update(
					{ status: "checking", sourceFilePath },
					checkingMessage,
					statusToolUpdate(
						"preparing",
						checkingMessage,
						backendMessage("sftp.upload_checking", { path: sourceFilePath }),
					),
				);
				sourceFilePath = getOrThrow(await options.env.absolutePath(sourceFilePath, activeSignal));
				const sourceInfo = getOrThrow(await options.env.fileInfo(sourceFilePath, activeSignal));
				if (sourceInfo.kind !== "file") throw new Error("sourceFilePath must identify a regular file");
				totalBytes = sourceInfo.size;

				const targetDirectory = requireRemoteDirectoryPath(params.targetPath);
				const target = await options.targets.resolve(options.sessionId);
				const directoryEntry = await options.broker.stat({
					target,
					remotePath: targetDirectory,
					signal: activeSignal,
				});
				if (directoryEntry.type !== "directory") throw new Error("targetPath must identify a remote directory");
				remotePath = posix.join(targetDirectory, basename(sourceFilePath));

				const existing = await statOptional(options.broker, target, remotePath, activeSignal);
				if (existing) {
					requireOverwriteable(existing);
					overwrite = await approveOverwrite(
						options.requestOverwriteApproval,
						toolCallId,
						existing,
						activeSignal,
						(entry, text) =>
							update(
								{ status: "awaiting_approval", sourceFilePath, remotePath, totalBytes, existingEntry: entry },
								text,
								statusToolUpdate(
									"waiting_for_approval",
									text,
									backendMessage("sftp.upload_waiting_approval", { path: entry.path }),
								),
							),
					);
				}

				const localPath = sourceFilePath;
				const destinationPath = remotePath;
				const fileSize = totalBytes;
				const upload = async (allowOverwrite: boolean) => {
					const progress = progressReporter(fileSize, localPath, destinationPath, allowOverwrite, update);
					progress(0, true);
					const result = await options.broker.upload({
						target,
						remotePath: destinationPath,
						data: localFileData(localPath, fileSize, activeSignal),
						signal: activeSignal,
						overwrite: allowOverwrite,
						onProgress: async (bytes) => {
							bytesTransferred = bytes;
							progress(bytes, bytes === fileSize);
						},
					});
					bytesTransferred = result.bytesTransferred;
					if (result.bytesTransferred !== fileSize)
						throw new Error("Uploaded bytes do not match the local file size");
					progress(result.bytesTransferred, true);
					return result;
				};

				try {
					await upload(overwrite);
				} catch (error) {
					if (error instanceof AgentRunError) throw error;
					if (!overwrite && error instanceof FileTransferError && error.code === "file_already_exists") {
						const raced = await options.broker.stat({ target, remotePath, signal: activeSignal });
						requireOverwriteable(raced);
						overwrite = await approveOverwrite(
							options.requestOverwriteApproval,
							toolCallId,
							raced,
							activeSignal,
							(entry, text) =>
								update(
									{
										status: "awaiting_approval",
										sourceFilePath,
										remotePath,
										totalBytes,
										existingEntry: entry,
									},
									text,
									statusToolUpdate(
										"waiting_for_approval",
										text,
										backendMessage("sftp.upload_waiting_approval", { path: entry.path }),
									),
								),
						);
						await upload(true);
					} else {
						throw error;
					}
				}

				const details: SftpUploadDetails = {
					status: "completed",
					sourceFilePath,
					remotePath,
					totalBytes,
					bytesTransferred,
					progressPercent: 100,
					overwrite,
					presentationMessage: backendMessage("sftp.upload_completed", {
						sourcePath: sourceFilePath,
						remotePath,
						bytes: bytesTransferred,
					}),
				};
				return {
					content: [
						{ type: "text", text: `Uploaded ${sourceFilePath} to ${remotePath} (${bytesTransferred} bytes).` },
					],
					details,
				};
			} catch (error) {
				if (error instanceof AgentRunError) throw error;
				const failure =
					activeSignal.aborted &&
					!(error instanceof SshAgentError && error.failure.code === "upload_result_uncertain")
						? new SftpCancelledError()
						: error;
				throw toolError(failure, {
					sourceFilePath,
					...(remotePath === undefined ? {} : { remotePath }),
					...(totalBytes === undefined ? {} : { totalBytes }),
					bytesTransferred,
					overwrite,
				});
			}
		},
	};
}

function requireRemoteDirectoryPath(path: string): string {
	if (!posix.isAbsolute(path)) throw new Error("targetPath must be an absolute remote directory path");
	const normalized = posix.normalize(path);
	return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

async function statOptional(
	broker: SftpFileBroker,
	target: Parameters<SftpFileBroker["stat"]>[0]["target"],
	remotePath: string,
	signal: AbortSignal,
): Promise<SftpDirectoryEntry | undefined> {
	try {
		return await broker.stat({ target, remotePath, signal });
	} catch (error) {
		if (error instanceof FileTransferError && error.code === "file_not_found") return undefined;
		throw error;
	}
}

function requireOverwriteable(entry: SftpDirectoryEntry): void {
	if (entry.type !== "file") throw new Error("The remote destination exists and is not a regular file");
}

async function approveOverwrite(
	requestApproval: RequestSftpOverwriteApproval,
	toolCallId: string,
	existingEntry: SftpDirectoryEntry,
	signal: AbortSignal,
	update: (entry: SftpDirectoryEntry, text: string) => void,
): Promise<true> {
	update(existingEntry, `Waiting for approval to overwrite ${existingEntry.path}`);
	const decision = await requestApproval(toolCallId, existingEntry, signal);
	if (decision.approved) return true;
	throw new SftpApprovalRejectedError(decision.reason);
}

function progressReporter(
	totalBytes: number,
	sourceFilePath: string,
	remotePath: string,
	overwrite: boolean,
	update: (details: SftpUploadDetails, text: string, transportUpdate?: ToolUpdate) => void,
): (bytes: number, force?: boolean) => void {
	let lastBytes = 0;
	let lastAt = 0;
	return (bytes, force = false) => {
		const now = Date.now();
		if (!force && bytes - lastBytes < PROGRESS_BYTES_INTERVAL && now - lastAt < PROGRESS_TIME_INTERVAL_MS) return;
		lastBytes = bytes;
		lastAt = now;
		const progressPercent = totalBytes === 0 ? 100 : Math.min(100, Math.floor((bytes / totalBytes) * 100));
		const message = `Uploading ${remotePath}`;
		update(
			{
				status: "uploading",
				sourceFilePath,
				remotePath,
				totalBytes,
				bytesTransferred: bytes,
				progressPercent,
				overwrite,
			},
			`${message}: ${bytes}/${totalBytes} bytes (${progressPercent}%)`,
			progressToolUpdate({
				current: bytes,
				total: totalBytes,
				unit: "bytes",
				message,
				messageDescriptor: backendMessage("sftp.upload_running", { path: remotePath }),
			}),
		);
	};
}

async function* localFileData(path: string, expectedBytes: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("sourceFilePath must identify a regular file");
		if (stats.size !== expectedBytes) throw new Error("The local file size changed before upload started");
		if (expectedBytes === 0) return;
		let bytes = 0;
		const stream = handle.createReadStream({ autoClose: false, start: 0, end: expectedBytes - 1, signal });
		for await (const chunk of stream) {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += data.byteLength;
			if (bytes > expectedBytes) throw new Error("The local file grew while it was being uploaded");
			yield new Uint8Array(data);
		}
		if (bytes !== expectedBytes) throw new Error("The local file changed while it was being uploaded");
	} finally {
		await handle.close();
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("SFTP upload was cancelled");
}

function toolError(error: unknown, details: Omit<SftpUploadDetails, "status">): AgentToolError<SftpUploadDetails> {
	const uncertain = error instanceof SshAgentError && error.failure.code === "upload_result_uncertain";
	const cancelled =
		error instanceof SftpApprovalRejectedError ||
		error instanceof SftpCancelledError ||
		(error instanceof SshAgentError && error.failure.code === "upload_cancelled") ||
		(error instanceof FileTransferError && error.code === "transfer_cancelled");
	const status: Extract<SftpUploadStatus, "failed" | "cancelled" | "uncertain"> = uncertain
		? "uncertain"
		: cancelled
			? "cancelled"
			: "failed";
	const message =
		error instanceof SftpApprovalRejectedError
			? approvalMessage(error.reason)
			: error instanceof Error
				? error.message
				: "SFTP upload failed";
	const presentationMessage = uploadFailureMessage(error, cancelled);
	return new AgentToolError({
		message,
		content: [
			{
				type: "text",
				text: uncertain
					? `${message}\nThe remote result is uncertain. Inspect the destination before attempting another upload.`
					: message,
			},
		],
		details: { status, ...details, presentationMessage },
		terminate: uncertain || error instanceof SftpApprovalRejectedError,
	});
}

function uploadFailureMessage(error: unknown, cancelled: boolean) {
	if (error instanceof FileTransferError && error.code === "transfer_queue_full") {
		return backendMessage("sftp.transfer_queue_full");
	}
	if (error instanceof SftpApprovalRejectedError) {
		const suffix =
			error.reason === "user_rejected"
				? "rejected"
				: error.reason === "timeout"
					? "timeout"
					: error.reason === "server_restarted"
						? "server_restarted"
						: "run_cancelled";
		return backendMessage(`sftp.remote_overwrite_${suffix}`);
	}
	return backendMessage(cancelled ? "sftp.upload_cancelled" : "sftp.upload_failed");
}

function approvalMessage(reason: SftpApprovalRejectedError["reason"]): string {
	if (reason === "user_rejected") return "Remote file overwrite was rejected by the user.";
	if (reason === "timeout") return "Remote file overwrite approval timed out.";
	if (reason === "server_restarted") return "Remote file overwrite was cancelled because the server restarted.";
	return "Remote file overwrite was cancelled because the Chat Run was cancelled.";
}

class SftpApprovalRejectedError extends Error {
	readonly reason: Exclude<SftpOverwriteApprovalDecision, { approved: true }>["reason"];

	constructor(reason: SftpApprovalRejectedError["reason"]) {
		super("SFTP overwrite approval was rejected");
		this.name = "SftpApprovalRejectedError";
		this.reason = reason;
	}
}

class SftpCancelledError extends Error {
	constructor() {
		super("SFTP upload was cancelled");
		this.name = "SftpCancelledError";
	}
}
