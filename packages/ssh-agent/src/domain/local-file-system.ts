export type LocalFileEntryType = "file" | "directory";

export interface LocalFileEntry {
	name: string;
	/** Absolute local path that can be passed directly to a local-file Tool. */
	path: string;
	/** Path relative to the Session working directory. */
	relativePath: string;
	type: LocalFileEntryType;
	size: number;
	modifiedAt: number;
}

export interface LocalDirectoryListing {
	rootPath: string;
	currentPath: string;
	relativePath: string;
	entries: LocalFileEntry[];
}

export type LocalFileSystemErrorCode =
	| "session_not_found"
	| "local_file_path_invalid"
	| "local_file_path_outside_work_dir"
	| "local_file_path_not_found"
	| "local_file_path_not_directory"
	| "local_file_path_symlink_not_allowed"
	| "local_file_access_denied"
	| "local_file_system_unavailable"
	| "session_work_dir_unavailable";

export class LocalFileSystemError extends Error {
	readonly code: LocalFileSystemErrorCode;
	readonly status: number;

	constructor(code: LocalFileSystemErrorCode, message: string, status: number, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "LocalFileSystemError";
		this.code = code;
		this.status = status;
	}
}
