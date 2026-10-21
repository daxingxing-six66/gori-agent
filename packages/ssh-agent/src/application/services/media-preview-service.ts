import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { LocalFileSystemError } from "../../domain/local-file-system.ts";
import { mediaFormat, type MediaPreviewFile } from "../../domain/media-preview.ts";
import { backendMessage } from "../../i18n/message.ts";
import { HttpBoundaryError } from "../failure-policy.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import { openLocalPreviewFile } from "./open-local-preview-file.ts";

/** Owns media access only; it does not decode text, contact SSH, or load media into model context. */
export class MediaPreviewService {
	constructor(options: { sessions: Pick<SessionRepository, "findById">; localCwd: string }) {
		this.options = options;
	}
	private readonly options: { sessions: Pick<SessionRepository, "findById">; localCwd: string };

	async open(sessionId: string, path: string) {
		const session = await this.options.sessions.findById(sessionId);
		if (!session) throw new LocalFileSystemError("session_not_found", "Session not found", 404);
		let root: string;
		try {
			root = await realpath(session.workDir ?? this.options.localCwd);
			if (!(await lstat(root)).isDirectory()) throw new Error("Not a directory");
		} catch {
			throw new LocalFileSystemError("session_work_dir_unavailable", "Session local working directory is unavailable", 409);
		}
		const opened = await openLocalPreviewFile(root, path);
		const format = mediaFormat(opened.path);
		if (!format) {
			await opened.file.close();
			throw new HttpBoundaryError("media_preview_type_unsupported", 415, backendMessage("media_preview.type_unsupported"));
		}
		const metadata: MediaPreviewFile = { path: opened.path, name: basename(opened.path), ...format,
			size: opened.stat.size, modifiedAt: opened.stat.mtimeMs };
		return { file: opened.file, metadata };
	}
}
