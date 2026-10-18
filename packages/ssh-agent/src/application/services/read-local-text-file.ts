import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, relative, isAbsolute, sep } from "node:path";
import { LocalFileSystemError, type LocalTextFile } from "../../domain/local-file-system.ts";

export const MAX_READER_FILE_BYTES = 1024 * 1024;

/** Reads a bounded regular UTF-8 file, using the same root and symlink rules as directory browsing. */
export async function readLocalTextFile(rootPath: string, path: string): Promise<LocalTextFile> {
	const relativePath = relative(rootPath, path);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new LocalFileSystemError("local_file_path_outside_work_dir", "File is outside the Session working directory", 403);
	}
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || await realpath(path) !== path) {
			throw new LocalFileSystemError("local_file_path_symlink_not_allowed", "File paths must not contain symbolic links", 403);
		}
		if (!metadata.isFile()) throw new LocalFileSystemError("local_file_path_not_file", "Path must identify a regular file", 400);
		// NOFOLLOW protects the final component if it changes after lstat. NONBLOCK
		// prevents a concurrently substituted FIFO from blocking the HTTP worker.
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const stat = await file.stat();
			if (!stat.isFile()) throw new LocalFileSystemError("local_file_path_not_file", "Path must identify a regular file", 400);
			if (stat.ino !== metadata.ino || stat.dev !== metadata.dev || await realpath(path) !== path) {
				throw new LocalFileSystemError("local_file_path_symlink_not_allowed", "File path changed during reading", 403);
			}
			if (stat.size > MAX_READER_FILE_BYTES) throw tooLarge();
			const buffer = Buffer.alloc(MAX_READER_FILE_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
				if (bytesRead === 0) break;
				size += bytesRead;
			}
			if (size > MAX_READER_FILE_BYTES) throw tooLarge();
			let content: string;
			try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)); }
			catch { throw new LocalFileSystemError("local_file_not_text", "Reader supports UTF-8 text files", 415); }
			if (/[\x00-\x08\x0e-\x1f]/.test(content)) {
				throw new LocalFileSystemError("local_file_not_text", "Binary files cannot be previewed as text", 415);
			}
			return { path, name: basename(path), content, size, modifiedAt: stat.mtimeMs };
		} finally { await file.close(); }
	} catch (error) {
		if (error instanceof LocalFileSystemError) throw error;
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		const cause = error instanceof Error ? error : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") throw new LocalFileSystemError("local_file_path_not_found", "File not found", 404, cause);
		if (code === "ELOOP") throw new LocalFileSystemError("local_file_path_symlink_not_allowed", "Symbolic links are not supported", 403, cause);
		if (code === "EACCES" || code === "EPERM") throw new LocalFileSystemError("local_file_access_denied", "Unable to read file", 403, cause);
		throw new LocalFileSystemError("local_file_system_unavailable", "Unable to read file", 500, cause);
	}
}

function tooLarge() {
	return new LocalFileSystemError("local_file_too_large", "Reader supports files up to 1 MiB", 413);
}
