import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SessionId } from "../../domain/ids.ts";
import {
	type LocalDirectoryListing,
	type LocalFileEntry,
	LocalFileSystemError,
} from "../../domain/local-file-system.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";

export interface LocalFileSystemService {
	listDirectory(sessionId: SessionId, path?: string): Promise<LocalDirectoryListing>;
	listSystemDirectory(path?: string): Promise<LocalDirectoryListing>;
}

export interface DefaultLocalFileSystemServiceOptions {
	sessions: Pick<SessionRepository, "findById">;
	localCwd: string;
}

export class DefaultLocalFileSystemService implements LocalFileSystemService {
	private readonly sessions: Pick<SessionRepository, "findById">;
	private readonly localCwd: string;

	constructor(options: DefaultLocalFileSystemServiceOptions) {
		this.sessions = options.sessions;
		this.localCwd = options.localCwd;
	}

	async listDirectory(sessionId: SessionId, path?: string): Promise<LocalDirectoryListing> {
		const session = await this.sessions.findById(sessionId);
		if (session === undefined) {
			throw new LocalFileSystemError("session_not_found", `Session not found: ${sessionId}`, 404);
		}

		const configuredRoot = session.workDir ?? this.localCwd;
		const rootPath = await this.resolveRoot(configuredRoot, true);
		return this.listWithinRoot(rootPath, path);
	}

	async listSystemDirectory(path?: string): Promise<LocalDirectoryListing> {
		const rootPath = await this.resolveRoot("/", false);
		return this.listWithinRoot(rootPath, path);
	}

	private async listWithinRoot(rootPath: string, path?: string): Promise<LocalDirectoryListing> {
		const requestedPath = path;
		if (requestedPath !== undefined && requestedPath.length > 0 && !isAbsolute(requestedPath)) {
			throw new LocalFileSystemError("local_file_path_invalid", "path must be an absolute local path", 400);
		}
		const currentPath = requestedPath === undefined || requestedPath.length === 0 ? rootPath : resolve(requestedPath);
		if (!isWithinRoot(rootPath, currentPath)) {
			throw new LocalFileSystemError(
				"local_file_path_outside_work_dir",
				"path must be inside the Session working directory",
				403,
			);
		}

		const directoryStat = await this.safeLstat(currentPath);
		if (directoryStat.isSymbolicLink()) {
			throw new LocalFileSystemError(
				"local_file_path_symlink_not_allowed",
				"symbolic links cannot be used as local directory paths",
				403,
			);
		}
		if (!directoryStat.isDirectory()) {
			throw new LocalFileSystemError("local_file_path_not_directory", "path must identify a directory", 400);
		}
		const canonicalPath = await this.safeRealpath(currentPath);
		if (canonicalPath !== currentPath || !isWithinRoot(rootPath, canonicalPath)) {
			throw new LocalFileSystemError(
				"local_file_path_symlink_not_allowed",
				"directory paths must not contain symbolic links",
				403,
			);
		}

		let names: string[];
		try {
			names = await readdir(currentPath);
		} catch (error) {
			throw fileSystemError(error, "Unable to read the local directory");
		}
		const entries = (
			await Promise.all(
				names.map(async (name): Promise<LocalFileEntry | undefined> => {
					const entryPath = resolve(currentPath, name);
					try {
						const entryStat = await lstat(entryPath);
						const type = entryStat.isDirectory() ? "directory" : entryStat.isFile() ? "file" : undefined;
						if (type === undefined) return undefined;
						return {
							name,
							path: entryPath,
							relativePath: relative(rootPath, entryPath),
							type,
							size: entryStat.size,
							modifiedAt: entryStat.mtimeMs,
						};
					} catch (error) {
						if (isErrno(error, "ENOENT")) return undefined;
						throw fileSystemError(error, `Unable to inspect local entry: ${name}`);
					}
				}),
			)
		).filter((entry): entry is LocalFileEntry => entry !== undefined);
		entries.sort((left, right) => {
			if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
			return left.name.localeCompare(right.name);
		});
		return {
			rootPath,
			currentPath,
			relativePath: relative(rootPath, currentPath),
			entries,
		};
	}

	private async resolveRoot(configuredRoot: string, sessionRoot: boolean): Promise<string> {
		try {
			const rootPath = await realpath(configuredRoot);
			if (!(await lstat(rootPath)).isDirectory()) throw new Error("not a directory");
			return rootPath;
		} catch (error) {
			throw new LocalFileSystemError(
				sessionRoot ? "session_work_dir_unavailable" : "local_file_system_unavailable",
				sessionRoot ? "Session local working directory is unavailable" : "System root directory is unavailable",
				sessionRoot ? 409 : 500,
				error instanceof Error ? error : undefined,
			);
		}
	}

	private async safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
		try {
			return await lstat(path);
		} catch (error) {
			throw fileSystemError(error, "Unable to inspect the local path");
		}
	}

	private async safeRealpath(path: string): Promise<string> {
		try {
			return await realpath(path);
		} catch (error) {
			throw fileSystemError(error, "Unable to resolve the local path");
		}
	}
}

function isWithinRoot(rootPath: string, path: string): boolean {
	const relativePath = relative(rootPath, path);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

function fileSystemError(error: unknown, message: string): LocalFileSystemError {
	const cause = error instanceof Error ? error : undefined;
	if (isErrno(error, "ENOENT")) return new LocalFileSystemError("local_file_path_not_found", message, 404, cause);
	if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
		return new LocalFileSystemError("local_file_access_denied", message, 403, cause);
	}
	return new LocalFileSystemError("local_file_system_unavailable", message, 500, cause);
}
