import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import {
	AgentRunError,
	type AgentTool,
	AgentToolError,
	type ExecutionEnv,
	getOrThrow,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { FileTransferError } from "../../domain/file-transfer.ts";
import type { SessionId } from "../../domain/ids.ts";
import { backendMessage } from "../../i18n/message.ts";
import { reportFailure } from "../failure-reporter.ts";
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

const sftpDownloadParameters = Type.Object({
	remoteFilePath: Type.String({
		minLength: 1,
		description: "Absolute file path on the current remote SSH server",
	}),
	targetPath: Type.String({
		minLength: 1,
		description: "Local directory path, relative to the Session working directory or absolute",
	}),
});

export type SftpDownloadParameters = Static<typeof sftpDownloadParameters>;

export type SftpDownloadStatus =
	| "checking"
	| "awaiting_approval"
	| "downloading"
	| "completed"
	| "failed"
	| "cancelled";

export interface SftpDownloadDetails extends ToolUpdateDetails {
	status: SftpDownloadStatus;
	remoteFilePath: string;
	localPath?: string;
	totalBytes?: number;
	bytesTransferred?: number;
	progressPercent?: number;
	overwrite?: boolean;
	existingEntry?: LocalDownloadEntry;
}

export interface LocalDownloadEntry {
	path: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number;
	modifiedAt: number;
}

export type SftpDownloadOverwriteApprovalDecision =
	| { approved: true }
	| { approved: false; reason: "user_rejected" | "timeout" | "run_cancelled" | "server_restarted" };

export type RequestSftpDownloadOverwriteApproval = (
	toolCallId: string,
	existingEntry: LocalDownloadEntry,
	signal: AbortSignal,
) => Promise<SftpDownloadOverwriteApprovalDecision>;

export const sftpDownloadDefinition = {
	name: "sftp_download",
	label: "SFTP file download",
	description:
		"Download one remote file to a local directory in the current Session. The remote file name is preserved.",
	parameters: sftpDownloadParameters,
};

export function createSftpDownloadTool(options: {
	sessionId: SessionId;
	env: Pick<ExecutionEnv, "absolutePath" | "fileInfo">;
	targets: SshTargetResolver;
	broker: SftpFileBroker;
	requestOverwriteApproval: RequestSftpDownloadOverwriteApproval;
}): AgentTool<typeof sftpDownloadParameters, SftpDownloadDetails> {
	return {
		...sftpDownloadDefinition,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeSignal = signal ?? new AbortController().signal;
			let remoteFilePath = params.remoteFilePath;
			let localPath: string | undefined;
			let temporaryPath: string | undefined;
			let totalBytes: number | undefined;
			let bytesTransferred = 0;
			let overwrite = false;
			const update = (
				details: SftpDownloadDetails,
				text: string,
				transportUpdate: ToolUpdate = textToolUpdate(text),
			) => onUpdate?.({ content: [{ type: "text", text }], details: { ...details, update: transportUpdate } });

			try {
				throwIfAborted(activeSignal);
				remoteFilePath = requireRemoteFilePath(remoteFilePath);
				const checkingMessage = `Checking remote file: ${remoteFilePath}`;
				update(
					{ status: "checking", remoteFilePath },
					checkingMessage,
					statusToolUpdate(
						"preparing",
						checkingMessage,
						backendMessage("sftp.download_checking", { path: remoteFilePath }),
					),
				);

				const target = await options.targets.resolve(options.sessionId);
				const remoteEntry = await options.broker.stat({ target, remotePath: remoteFilePath, signal: activeSignal });
				if (remoteEntry.type !== "file") throw new Error("remoteFilePath must identify a regular remote file");
				totalBytes = remoteEntry.size;

				const targetDirectory = getOrThrow(await options.env.absolutePath(params.targetPath, activeSignal));
				const targetInfo = getOrThrow(await options.env.fileInfo(targetDirectory, activeSignal));
				if (targetInfo.kind !== "directory") throw new Error("targetPath must identify a local directory");
				localPath = join(targetDirectory, posix.basename(remoteFilePath));

				const existing = await localEntryOptional(localPath);
				if (existing) {
					requireOverwriteable(existing);
					overwrite = await approveOverwrite(
						options.requestOverwriteApproval,
						toolCallId,
						existing,
						activeSignal,
						(entry, text) =>
							update(
								{
									status: "awaiting_approval",
									remoteFilePath,
									localPath,
									totalBytes,
									existingEntry: entry,
								},
								text,
								statusToolUpdate(
									"waiting_for_approval",
									text,
									backendMessage("sftp.download_waiting_approval", { path: entry.path }),
								),
							),
					);
				}

				const destinationPath = localPath;
				const expectedBytes = totalBytes;
				temporaryPath = join(targetDirectory, `.${posix.basename(remoteFilePath)}.pi-download-${randomUUID()}.tmp`);
				const stagingPath = temporaryPath;
				// Queued downloads must not each hold an open local file descriptor.
				let handle: Awaited<ReturnType<typeof open>> | undefined;
				try {
					const progress = progressReporter(expectedBytes, remoteFilePath, destinationPath, overwrite, update);
					progress(0, true);
					let bytesWritten = 0;
					const result = await options.broker.download({
						target,
						remotePath: remoteFilePath,
						signal: activeSignal,
						onData: async (chunk) => {
							throwIfAborted(activeSignal);
							if (bytesWritten + chunk.byteLength > expectedBytes)
								throw new Error("The remote file grew while it was being downloaded");
							handle ??= await open(stagingPath, "wx", 0o600);
							let chunkOffset = 0;
							while (chunkOffset < chunk.byteLength) {
								const result = await handle.write(
									chunk,
									chunkOffset,
									chunk.byteLength - chunkOffset,
									bytesWritten + chunkOffset,
								);
								if (result.bytesWritten === 0) throw new Error("Failed to write downloaded file data");
								chunkOffset += result.bytesWritten;
							}
							bytesWritten += chunk.byteLength;
						},
						onProgress: async (bytes) => {
							bytesTransferred = bytes;
							progress(bytes, bytes === expectedBytes);
						},
					});
					bytesTransferred = result.bytesTransferred;
					if (bytesWritten !== expectedBytes || result.bytesTransferred !== expectedBytes)
						throw new Error("Downloaded bytes do not match the remote file size");
					// Empty files have no onData callback, but still need a staging file.
					handle ??= await open(stagingPath, "wx", 0o600);
					await handle.sync();
					progress(result.bytesTransferred, true);
				} finally {
					await handle?.close();
				}

				throwIfAborted(activeSignal);
				if (overwrite) {
					await rename(temporaryPath, destinationPath);
					temporaryPath = undefined;
				} else {
					try {
						await link(temporaryPath, destinationPath);
						try {
							await rm(temporaryPath);
							temporaryPath = undefined;
						} catch (error) {
							reportFailure(error, { stage: "cleanup", sessionId: options.sessionId });
							// The destination is already committed. The outer cleanup gets one more chance to remove staging.
						}
					} catch (error) {
						if (error instanceof AgentRunError) throw error;
						if (!isFileExistsError(error)) throw error;
						const raced = await localEntryRequired(destinationPath);
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
										remoteFilePath,
										localPath,
										totalBytes,
										bytesTransferred,
										existingEntry: entry,
									},
									text,
									statusToolUpdate(
										"waiting_for_approval",
										text,
										backendMessage("sftp.download_waiting_approval", { path: entry.path }),
									),
								),
						);
						throwIfAborted(activeSignal);
						if (temporaryPath === undefined) throw new Error("Local download staging file is unavailable");
						await rename(temporaryPath, destinationPath);
						temporaryPath = undefined;
					}
				}

				return {
					content: [
						{ type: "text", text: `Downloaded ${remoteFilePath} to ${localPath} (${bytesTransferred} bytes).` },
					],
					details: {
						status: "completed",
						remoteFilePath,
						localPath,
						totalBytes,
						bytesTransferred,
						progressPercent: 100,
						overwrite,
						presentationMessage: backendMessage("sftp.download_completed", {
							remotePath: remoteFilePath,
							localPath,
							bytes: bytesTransferred,
						}),
					},
				};
			} catch (error) {
				if (error instanceof AgentRunError) throw error;
				throw toolError(error, {
					remoteFilePath,
					...(localPath === undefined ? {} : { localPath }),
					...(totalBytes === undefined ? {} : { totalBytes }),
					bytesTransferred,
					overwrite,
				});
			} finally {
				if (temporaryPath !== undefined)
					await rm(temporaryPath, { force: true }).catch((error) => {
						reportFailure(error, { stage: "cleanup", sessionId: options.sessionId });
					});
			}
		},
	};
}

function requireRemoteFilePath(path: string): string {
	if (!posix.isAbsolute(path)) throw new Error("remoteFilePath must be an absolute remote file path");
	const normalized = posix.normalize(path);
	if (normalized === "/" || path.endsWith("/")) throw new Error("remoteFilePath must identify a remote file");
	return normalized;
}

async function localEntryOptional(path: string): Promise<LocalDownloadEntry | undefined> {
	try {
		return localEntry(path, await lstat(path));
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

async function localEntryRequired(path: string): Promise<LocalDownloadEntry> {
	return localEntry(path, await lstat(path));
}

function localEntry(
	path: string,
	stats: {
		isFile(): boolean;
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
		size: number;
		mtimeMs: number;
	},
): LocalDownloadEntry {
	const type = stats.isFile()
		? "file"
		: stats.isDirectory()
			? "directory"
			: stats.isSymbolicLink()
				? "symlink"
				: "other";
	return { path, type, size: stats.size, modifiedAt: stats.mtimeMs };
}

function requireOverwriteable(entry: LocalDownloadEntry): void {
	if (entry.type !== "file") throw new Error("The local destination exists and is not a regular file");
}

async function approveOverwrite(
	requestApproval: RequestSftpDownloadOverwriteApproval,
	toolCallId: string,
	existingEntry: LocalDownloadEntry,
	signal: AbortSignal,
	update: (entry: LocalDownloadEntry, text: string) => void,
): Promise<true> {
	update(existingEntry, `Waiting for approval to overwrite ${existingEntry.path}`);
	const decision = await requestApproval(toolCallId, existingEntry, signal);
	if (decision.approved) return true;
	throw new SftpDownloadApprovalRejectedError(decision.reason);
}

function progressReporter(
	totalBytes: number,
	remoteFilePath: string,
	localPath: string,
	overwrite: boolean,
	update: (details: SftpDownloadDetails, text: string, transportUpdate?: ToolUpdate) => void,
): (bytes: number, force?: boolean) => void {
	let lastBytes = 0;
	let lastAt = 0;
	return (bytes, force = false) => {
		const now = Date.now();
		if (!force && bytes - lastBytes < PROGRESS_BYTES_INTERVAL && now - lastAt < PROGRESS_TIME_INTERVAL_MS) return;
		lastBytes = bytes;
		lastAt = now;
		const progressPercent = totalBytes === 0 ? 100 : Math.min(100, Math.floor((bytes / totalBytes) * 100));
		const message = `Downloading ${remoteFilePath}`;
		update(
			{
				status: "downloading",
				remoteFilePath,
				localPath,
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
				messageDescriptor: backendMessage("sftp.download_running", { path: remoteFilePath }),
			}),
		);
	};
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new SftpDownloadCancelledError();
}

function toolError(error: unknown, details: Omit<SftpDownloadDetails, "status">): AgentToolError<SftpDownloadDetails> {
	const cancelled =
		error instanceof SftpDownloadApprovalRejectedError ||
		error instanceof SftpDownloadCancelledError ||
		(error instanceof FileTransferError && error.code === "transfer_cancelled");
	const message =
		error instanceof SftpDownloadApprovalRejectedError
			? approvalMessage(error.reason)
			: error instanceof Error
				? error.message
				: "SFTP download failed";
	const presentationMessage = downloadFailureMessage(error, cancelled);
	return new AgentToolError({
		message,
		content: [{ type: "text", text: message }],
		details: { status: cancelled ? "cancelled" : "failed", ...details, presentationMessage },
		terminate: error instanceof SftpDownloadApprovalRejectedError,
	});
}

function downloadFailureMessage(error: unknown, cancelled: boolean) {
	if (error instanceof FileTransferError && error.code === "transfer_queue_full") {
		return backendMessage("sftp.transfer_queue_full");
	}
	if (error instanceof SftpDownloadApprovalRejectedError) {
		const suffix =
			error.reason === "user_rejected"
				? "rejected"
				: error.reason === "timeout"
					? "timeout"
					: error.reason === "server_restarted"
						? "server_restarted"
						: "run_cancelled";
		return backendMessage(`sftp.local_overwrite_${suffix}`);
	}
	return backendMessage(cancelled ? "sftp.download_cancelled" : "sftp.download_failed");
}

function approvalMessage(reason: SftpDownloadApprovalRejectedError["reason"]): string {
	if (reason === "user_rejected") return "Local file overwrite was rejected by the user.";
	if (reason === "timeout") return "Local file overwrite approval timed out.";
	if (reason === "server_restarted") return "Local file overwrite was cancelled because the server restarted.";
	return "Local file overwrite was cancelled because the Chat Run was cancelled.";
}

function isMissingFileError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "EEXIST";
}

class SftpDownloadApprovalRejectedError extends Error {
	readonly reason: Exclude<SftpDownloadOverwriteApprovalDecision, { approved: true }>["reason"];

	constructor(reason: SftpDownloadApprovalRejectedError["reason"]) {
		super("SFTP download overwrite approval was rejected");
		this.name = "SftpDownloadApprovalRejectedError";
		this.reason = reason;
	}
}

class SftpDownloadCancelledError extends Error {
	constructor() {
		super("SFTP download was cancelled");
		this.name = "SftpDownloadCancelledError";
	}
}
