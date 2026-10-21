import { basename } from "node:path";
import { LocalFileSystemError, type LocalTextFile } from "../../domain/local-file-system.ts";
import { localPreviewError, openLocalPreviewFile } from "./open-local-preview-file.ts";

export const MAX_READER_FILE_BYTES = 1024 * 1024;

/** Reads a bounded regular UTF-8 file, using the same root and symlink rules as directory browsing. */
export async function readLocalTextFile(rootPath: string, path: string): Promise<LocalTextFile> {
	try {
		const opened = await openLocalPreviewFile(rootPath, path);
		const { file, stat } = opened;
		try {
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
			return { path: opened.path, name: basename(opened.path), content, size, modifiedAt: stat.mtimeMs };
		} finally { await file.close(); }
	} catch (error) {
		throw localPreviewError(error);
	}
}

function tooLarge() {
	return new LocalFileSystemError("local_file_too_large", "Reader supports files up to 1 MiB", 413);
}
