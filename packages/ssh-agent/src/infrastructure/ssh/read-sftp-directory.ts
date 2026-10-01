import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { FileTransferError, type SftpDirectoryEntry } from "../../domain/file-transfer.ts";

/** Shared directory projection for persisted workspaces and unsaved connection drafts. */
export async function readSftpDirectory(sftp: SFTPWrapper, remotePath: string): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
	try {
		const path = await realpath(sftp, remotePath);
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
	} catch (error) {
		if (error instanceof FileTransferError) throw error;
		throw mapSftpError(error);
	}
}

function realpath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
	return new Promise((resolve, reject) => sftp.realpath(remotePath, (error, path) => error ? reject(error) : resolve(path)));
}

function readdir(sftp: SFTPWrapper, remotePath: string): Promise<FileEntryWithStats[]> {
	return new Promise((resolve, reject) => sftp.readdir(remotePath, (error, entries) => error ? reject(error) : resolve(entries)));
}

function lstat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
	return new Promise((resolve, reject) => sftp.lstat(remotePath, (error, stats) => error ? reject(error) : resolve(stats)));
}

function directoryEntry(parentPath: string, name: string, stats: Stats): SftpDirectoryEntry {
	const path = `${parentPath}${parentPath === "/" ? "" : "/"}${name}`;
	const type = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other";
	return { name, path, type, size: stats.size, modifiedAt: stats.mtime * 1_000, permissions: stats.mode & 0o7777 };
}

function mapSftpError(error: unknown): FileTransferError {
	const code = (error as Error & { code?: number }).code;
	if (code === 2) return new FileTransferError("file_not_found", "The remote path does not exist", 404);
	if (code === 3) return new FileTransferError("sftp_permission_denied", "Permission was denied for the remote path", 403);
	return new FileTransferError("sftp_operation_failed", "The SFTP operation failed", 502);
}
