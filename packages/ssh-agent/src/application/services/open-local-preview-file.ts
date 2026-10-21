import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LocalFileSystemError } from "../../domain/local-file-system.ts";

/** Only macOS-owned root aliases are normalized; user-created symlinks remain forbidden. */
export function localSystemPath(path: string): string {
	if (process.platform !== "darwin") return path;
	return path.replace(/^\/(tmp|var|etc)(?=\/|$)/u, "/private/$1");
}

/** Shared filesystem boundary only. Text decoding and media streaming stay in their own modules. */
export async function openLocalPreviewFile(root: string, requestedPath: string) {
	if (!requestedPath.trim() || requestedPath.includes("\0")) {
		throw new LocalFileSystemError("local_file_path_invalid", "A file path is required", 400);
	}
	const rootPath = localSystemPath(root);
	const path = localSystemPath(resolve(rootPath, requestedPath));
	const relativePath = relative(rootPath, path);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new LocalFileSystemError("local_file_path_outside_work_dir", "File is outside the Session working directory", 403);
	}
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || await realpath(path) !== path) throw symlinkError();
		if (!metadata.isFile()) throw new LocalFileSystemError("local_file_path_not_file", "Path must identify a regular file", 400);
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const stat = await file.stat();
			if (!stat.isFile()) throw new LocalFileSystemError("local_file_path_not_file", "Path must identify a regular file", 400);
			if (stat.ino !== metadata.ino || stat.dev !== metadata.dev || await realpath(path) !== path) throw symlinkError();
			return { file, path, stat };
		} catch (error) { await file.close(); throw error; }
	} catch (error) { throw localPreviewError(error); }
}

export function localPreviewError(error: unknown): LocalFileSystemError {
	if (error instanceof LocalFileSystemError) return error;
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	const cause = error instanceof Error ? error : undefined;
	if (code === "ENOENT" || code === "ENOTDIR") return new LocalFileSystemError("local_file_path_not_found", "File not found", 404, cause);
	if (code === "ELOOP") return symlinkError();
	if (code === "EACCES" || code === "EPERM") return new LocalFileSystemError("local_file_access_denied", "Unable to read file", 403, cause);
	return new LocalFileSystemError("local_file_system_unavailable", "Unable to read file", 500, cause);
}

function symlinkError() {
	return new LocalFileSystemError("local_file_path_symlink_not_allowed", "File paths must not contain symbolic links", 403);
}
