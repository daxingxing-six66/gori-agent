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
import { Ssh2SftpChannelPool } from "./ssh2-sftp-channel-pool.ts";

export class Ssh2SftpFileBroker implements SftpFileBroker {
	private readonly channels: Ssh2SftpChannelPool;

	constructor(pool: Ssh2ConnectionPool) {
		this.channels = new Ssh2SftpChannelPool(pool);
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
		return await this.channels.use(input,
			(sftp, context) => this.uploadWithConnection(sftp, context, input), uploadCancellationError);
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
				streamClose ??= new Promise<void>((resolve) => {
					if (!context.isCurrent()) { resolve(); return; }
					const finish = () => {
						clearTimeout(timer);
						sftp.removeListener("close", finish);
						resolve();
					};
					const timer = setTimeout(finish, 1_000);
					timer.unref();
					sftp.once("close", finish);
					try { stream.close(finish); } catch { finish(); }
				});
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

	close(): void {
		this.channels.close();
	}

	private async uploadWithConnection(
		sftp: SFTPWrapper,
		context: Ssh2ConnectionContext,
		input: UploadRemoteFileInput,
	): Promise<RemoteUploadResult> {
		const temporaryPath = temporaryUploadPath(input.remotePath);
		let handle: Buffer | undefined;
		let bytesTransferred = 0;
		let committing = false;
		let iterator: AsyncIterator<Uint8Array> | undefined;
		try {
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
			handle = await interruptibleUpload(context, sftp, input.signal, false, () =>
				openRemoteFile(sftp, temporaryPath).then(async (opened) => {
					if (input.signal.aborted || !context.isCurrent()) {
						if (context.isCurrent()) {
							const cleanupSignal = AbortSignal.timeout(1_000);
							await interruptibleUpload(context, sftp, cleanupSignal, false, () => closeRemoteFile(sftp, opened)).catch(() => {});
							await interruptibleUpload(context, sftp, cleanupSignal, false, () => unlinkRemoteFile(sftp, temporaryPath)).catch(() => {});
						}
						throw uploadCancellationError();
					}
					return opened;
				}));
			iterator = input.data[Symbol.asyncIterator]();
			while (true) {
				const next = await interruptibleUpload(context, sftp, input.signal, false, () => iterator!.next());
				if (next.done) break;
				const chunk = next.value;
				if (chunk.byteLength === 0) continue;
				const buffer = Buffer.from(chunk);
				await interruptibleUpload(
					context,
					sftp,
					input.signal,
					false,
					() => writeRemoteFile(sftp, handle!, buffer, bytesTransferred),
				);
				bytesTransferred += buffer.byteLength;
				await interruptibleUpload(context, sftp, input.signal, false, () => input.onProgress(bytesTransferred));
			}
			await interruptibleUpload(context, sftp, input.signal, false, () => closeRemoteFile(sftp, handle!));
			handle = undefined;
			committing = true;
			await interruptibleUpload(
				context,
				sftp,
				input.signal,
				true,
				() => input.overwrite
					? atomicRenameRemoteFile(sftp, temporaryPath, input.remotePath)
					: renameRemoteFile(sftp, temporaryPath, input.remotePath),
			);
			return { bytesTransferred };
		} catch (error) {
			// A dead channel cannot acknowledge cleanup; never mask an uncertain commit by waiting on it.
			if (context.isCurrent()) {
				const cleanupSignal = AbortSignal.timeout(1_000);
				if (handle) await interruptibleUpload(context, sftp, cleanupSignal, false,
					() => closeRemoteFile(sftp, handle!)).catch(() => {});
				await interruptibleUpload(context, sftp, cleanupSignal, false,
					() => unlinkRemoteFile(sftp, temporaryPath)).catch(() => {});
			}
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
			// Closing a source belongs to this upload, never to the shared SFTP channel.
			if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
		}
	}

	private withSftp<T>(
		input: SftpPathInput,
		operation: (sftp: SFTPWrapper, context: Ssh2ConnectionContext) => Promise<T>,
	): Promise<T> {
		return this.channels.use(input, async (sftp, context) => {
			try {
				return await operation(sftp, context);
			} catch (error) {
				if (error instanceof FileTransferError || error instanceof SshAgentError) throw error;
				throw mapSftpError(error);
			}
		});
	}
}

function interruptibleUpload<T>(
	context: Ssh2ConnectionContext,
	sftp: SFTPWrapper,
	signal: AbortSignal,
	committing: boolean,
	operation: () => Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			context.client.removeListener("close", onClose);
			sftp.removeListener("close", onClose);
			sftp.removeListener("error", onClose);
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
		sftp.once("close", onClose);
		sftp.once("error", onClose);
		if (!context.isCurrent()) { onClose(); return; }
		Promise.resolve().then(() => {
			if (signal.aborted) throw uploadCancellationError();
			return operation();
		}).then(
			(value) => finish(() => resolve(value)),
			(error: unknown) =>
				finish(() =>
					reject(
						(error instanceof SshAgentError || error instanceof FileTransferError) && !(committing && !context.isCurrent())
							? error
							: createSshError(
									committing && !context.isCurrent() ? "upload_result_uncertain" : committing ? "upload_commit_failed" : "upload_failed",
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
