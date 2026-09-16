import { randomUUID } from "node:crypto";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import type {
	DownloadRemoteFileInput,
	RemoteDownloadResult,
	RemoteUploadResult,
	SftpFileBroker,
	SftpPathInput,
	UploadRemoteFileInput,
} from "../../application/ssh-channel-broker.ts";
import { FileTransferError, type SftpDirectoryEntry } from "../../domain/file-transfer.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { Ssh2ConnectionContext, Ssh2ConnectionPool } from "./ssh2-connection-pool.ts";
import { createSshError } from "./ssh2-errors.ts";

export class Ssh2SftpFileBroker implements SftpFileBroker {
	private readonly pool: Ssh2ConnectionPool;

	constructor(pool: Ssh2ConnectionPool) {
		this.pool = pool;
	}

	listDirectory(input: SftpPathInput): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
		return this.withSftp(input, async (sftp) => {
			const path = await realpath(sftp, input.remotePath);
			if (!(await lstat(sftp, path)).isDirectory())
				throw new FileTransferError("not_a_directory", "The remote path is not a directory", 409);
			const entries = (await readdir(sftp, path))
				.filter((entry) => entry.filename !== "." && entry.filename !== "..")
				.map((entry) => directoryEntry(path, entry.filename, entry.attrs))
				.sort((left, right) => {
					if (left.type === "directory" && right.type !== "directory") return -1;
					if (left.type !== "directory" && right.type === "directory") return 1;
					return left.name.localeCompare(right.name);
				});
			return { path, entries };
		});
	}

	stat(input: SftpPathInput): Promise<SftpDirectoryEntry> {
		return this.withSftp(input, async (sftp) =>
			directoryEntryForPath(input.remotePath, await lstat(sftp, input.remotePath)),
		);
	}

	async upload(input: UploadRemoteFileInput): Promise<RemoteUploadResult> {
		if (input.signal.aborted) throw uploadCancellationError();
		if (!input.remotePath || input.remotePath.endsWith("/")) {
			throw createSshError("invalid_request", "request", "validate", "Remote upload path must identify a file");
		}
		return await this.pool.withChannelSlot({
			target: input.target,
			signal: input.signal,
			cancellationError: uploadCancellationError,
			operation: (context) => this.uploadWithConnection(context, input),
		});
	}

	download(input: DownloadRemoteFileInput): Promise<RemoteDownloadResult> {
		return this.withSftp(input, async (sftp, context) => {
			const stats = await lstat(sftp, input.remotePath);
			if (stats.isDirectory())
				throw new FileTransferError("cannot_download_directory", "Directories cannot be downloaded", 409);
			if (!stats.isFile())
				throw new FileTransferError("unsupported_file_type", "Only regular files can be downloaded", 409);
			const stream = sftp.createReadStream(input.remotePath, { autoClose: false });
			let streamClose: Promise<void> | undefined;
			const closeStream = () => {
				streamClose ??= new Promise<void>((resolve) => stream.close(() => resolve()));
				return streamClose;
			};
			const onAbort = () => {
				stream.destroy(new FileTransferError("transfer_cancelled", "File download was cancelled", 409));
			};
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
			let bytesTransferred = 0;
			try {
				for await (const chunk of stream) {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					await input.onData(new Uint8Array(buffer));
					bytesTransferred += buffer.byteLength;
					await input.onProgress(bytesTransferred);
				}
				return { bytesTransferred };
			} catch (error) {
				if (error instanceof FileTransferError) throw error;
				if (!context.isCurrent())
					throw new FileTransferError("sftp_operation_failed", "SSH transport was lost during download", 502);
				throw new FileTransferError("sftp_operation_failed", "Failed to download the remote file", 502);
			} finally {
				input.signal.removeEventListener("abort", onAbort);
				await closeStream();
			}
		});
	}

	async deleteFile(input: SftpPathInput): Promise<void> {
		await this.withSftp(input, async (sftp) => {
			const stats = await lstat(sftp, input.remotePath);
			if (stats.isDirectory())
				throw new FileTransferError("cannot_delete_directory", "Directories cannot be deleted", 409);
			await unlinkRemoteFile(sftp, input.remotePath);
		});
	}

	private async uploadWithConnection(
		context: Ssh2ConnectionContext,
		input: UploadRemoteFileInput,
	): Promise<RemoteUploadResult> {
		const temporaryPath = temporaryUploadPath(input.remotePath);
		let sftp: SFTPWrapper | undefined;
		let handle: Buffer | undefined;
		let bytesTransferred = 0;
		let committing = false;
		try {
			sftp = await interruptibleUpload(
				context,
				input.signal,
				false,
				openSftp(context).catch((error: unknown) => {
					throw createSshError(
						"sftp_channel_open_failed",
						"channel",
						"acquire_channel",
						"Failed to open SSH SFTP channel",
						undefined,
						false,
						error instanceof Error ? error : undefined,
					);
				}),
			);
			const existing = await lstatOptional(sftp, input.remotePath);
			if (existing !== undefined) {
				const existingEntry = directoryEntryForPath(input.remotePath, existing);
				if (!input.overwrite) {
					throw new FileTransferError("file_already_exists", "A file already exists at the remote path", 409, {
						entry: existingEntry,
					});
				}
				if (!existing.isFile())
					throw new FileTransferError("unsupported_file_type", "Only regular files can be overwritten", 409);
			}
			handle = await interruptibleUpload(context, input.signal, false, openRemoteFile(sftp, temporaryPath));
			const iterator = input.data[Symbol.asyncIterator]();
			while (true) {
				const next = await interruptibleUpload(context, input.signal, false, iterator.next());
				if (next.done) break;
				const chunk = next.value;
				if (chunk.byteLength === 0) continue;
				const buffer = Buffer.from(chunk);
				await interruptibleUpload(
					context,
					input.signal,
					false,
					writeRemoteFile(sftp, handle, buffer, bytesTransferred),
				);
				bytesTransferred += buffer.byteLength;
				await interruptibleUpload(context, input.signal, false, input.onProgress(bytesTransferred));
			}
			await interruptibleUpload(context, input.signal, false, closeRemoteFile(sftp, handle));
			handle = undefined;
			committing = true;
			await interruptibleUpload(
				context,
				input.signal,
				true,
				input.overwrite
					? atomicRenameRemoteFile(sftp, temporaryPath, input.remotePath)
					: renameRemoteFile(sftp, temporaryPath, input.remotePath),
			);
			return { bytesTransferred };
		} catch (error) {
			if (handle && sftp) await closeRemoteFile(sftp, handle).catch(() => {});
			if (sftp) await unlinkRemoteFile(sftp, temporaryPath).catch(() => {});
			if (error instanceof SshAgentError || error instanceof FileTransferError) throw error;
			throw createSshError(
				committing ? "upload_commit_failed" : "upload_failed",
				"execution",
				committing ? "commit" : "upload",
				committing ? "Failed to commit the uploaded file" : "Failed to upload the file",
				undefined,
				false,
				error instanceof Error ? error : undefined,
			);
		} finally {
			sftp?.end();
		}
	}

	private withSftp<T>(
		input: SftpPathInput,
		operation: (sftp: SFTPWrapper, context: Ssh2ConnectionContext) => Promise<T>,
	): Promise<T> {
		return this.pool.withChannelSlot({
			target: input.target,
			signal: input.signal,
			cancellationError: () => new FileTransferError("transfer_cancelled", "SFTP operation was cancelled", 409),
			operation: async (context) => {
				let sftp: SFTPWrapper | undefined;
				try {
					sftp = await openSftp(context);
					return await operation(sftp, context);
				} catch (error) {
					if (error instanceof FileTransferError || error instanceof SshAgentError) throw error;
					throw mapSftpError(error);
				} finally {
					sftp?.end();
				}
			},
		});
	}
}

function interruptibleUpload<T>(
	context: Ssh2ConnectionContext,
	signal: AbortSignal,
	committing: boolean,
	operation: Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			context.client.removeListener("close", onClose);
			callback();
		};
		const onAbort = () =>
			finish(() =>
				reject(
					committing
						? createSshError(
								"upload_result_uncertain",
								"execution",
								"commit",
								"Upload cancellation occurred after rename was sent; the remote result is uncertain",
								{ generation: context.generation },
							)
						: uploadCancellationError(),
				),
			);
		const onClose = () =>
			finish(() =>
				reject(
					createSshError(
						committing ? "upload_result_uncertain" : "upload_failed",
						"execution",
						committing ? "commit" : "upload",
						committing
							? "SSH transport was lost while committing the upload; the remote result is uncertain"
							: "SSH transport was lost while uploading the temporary file",
						{ generation: context.generation },
						!committing,
					),
				),
			);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		context.client.once("close", onClose);
		operation.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) =>
				finish(() =>
					reject(
						error instanceof SshAgentError || error instanceof FileTransferError
							? error
							: createSshError(
									committing ? "upload_commit_failed" : "upload_failed",
									"execution",
									committing ? "commit" : "upload",
									committing ? "Failed to commit the uploaded file" : "Failed to upload the file",
									undefined,
									false,
									error instanceof Error ? error : undefined,
								),
					),
				),
		);
	});
}

function uploadCancellationError(): SshAgentError {
	return createSshError("upload_cancelled", "execution", "cancel", "File upload was cancelled");
}

function temporaryUploadPath(remotePath: string): string {
	const separator = remotePath.lastIndexOf("/");
	const directory = remotePath.slice(0, separator + 1);
	const filename = remotePath.slice(separator + 1);
	return `${directory}.${filename}.pi-upload-${randomUUID()}.tmp`;
}

function openSftp(context: Ssh2ConnectionContext): Promise<SFTPWrapper> {
	return new Promise((resolve, reject) => {
		context.client.sftp((error, sftp) => {
			if (error) reject(error);
			else resolve(sftp);
		});
	});
}

function openRemoteFile(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		sftp.open(remotePath, "w", (error, handle) => {
			if (error) reject(error);
			else resolve(handle);
		});
	});
}

function writeRemoteFile(sftp: SFTPWrapper, handle: Buffer, buffer: Buffer, position: number): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.write(handle, buffer, 0, buffer.byteLength, position, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function closeRemoteFile(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.close(handle, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function renameRemoteFile(sftp: SFTPWrapper, temporaryPath: string, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.rename(temporaryPath, remotePath, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function unlinkRemoteFile(sftp: SFTPWrapper, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.unlink(remotePath, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function realpath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
	return new Promise((resolve, reject) =>
		sftp.realpath(remotePath, (error, path) => (error ? reject(error) : resolve(path))),
	);
}

function readdir(sftp: SFTPWrapper, remotePath: string): Promise<FileEntryWithStats[]> {
	return new Promise((resolve, reject) =>
		sftp.readdir(remotePath, (error, entries) => (error ? reject(error) : resolve(entries))),
	);
}

function lstat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
	return new Promise((resolve, reject) =>
		sftp.lstat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats))),
	);
}

async function lstatOptional(sftp: SFTPWrapper, remotePath: string): Promise<Stats | undefined> {
	try {
		return await lstat(sftp, remotePath);
	} catch (error) {
		if ((error as Error & { code?: number }).code === 2) return undefined;
		throw error;
	}
}

function atomicRenameRemoteFile(sftp: SFTPWrapper, temporaryPath: string, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			sftp.ext_openssh_rename(temporaryPath, remotePath, (error) => {
				if (error?.message === "Server does not support this extended request")
					reject(atomicOverwriteUnsupported());
				else if (error) reject(mapSftpError(error));
				else resolve();
			});
		} catch (error) {
			reject(
				error instanceof Error && error.message === "Server does not support this extended request"
					? atomicOverwriteUnsupported()
					: mapSftpError(error),
			);
		}
	});
}

function atomicOverwriteUnsupported(): FileTransferError {
	return new FileTransferError(
		"atomic_overwrite_unsupported",
		"The SSH server does not support atomic file replacement",
		409,
	);
}

function directoryEntry(parentPath: string, name: string, stats: Stats): SftpDirectoryEntry {
	const separator = parentPath === "/" ? "" : "/";
	return entryFromStats(name, `${parentPath}${separator}${name}`, stats);
}

function directoryEntryForPath(remotePath: string, stats: Stats): SftpDirectoryEntry {
	const trimmed = remotePath === "/" ? remotePath : remotePath.replace(/\/+$/, "");
	const name = trimmed === "/" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
	return entryFromStats(name, trimmed, stats);
}

function entryFromStats(name: string, path: string, stats: Stats): SftpDirectoryEntry {
	const type = stats.isDirectory()
		? "directory"
		: stats.isFile()
			? "file"
			: stats.isSymbolicLink()
				? "symlink"
				: "other";
	return { name, path, type, size: stats.size, modifiedAt: stats.mtime * 1_000, permissions: stats.mode & 0o7777 };
}

function mapSftpError(error: unknown): FileTransferError {
	const code = (error as Error & { code?: number }).code;
	if (code === 2) return new FileTransferError("file_not_found", "The remote path does not exist", 404);
	if (code === 3)
		return new FileTransferError("sftp_permission_denied", "Permission was denied for the remote path", 403);
	return new FileTransferError("sftp_operation_failed", "The SFTP operation failed", 502);
}
