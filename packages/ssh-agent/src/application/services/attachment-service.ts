import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { type Attachment, AttachmentError } from "../../domain/attachment.ts";
import type { Clock, IdGenerator, SessionId } from "../../domain/ids.ts";
import type { AttachmentRepository } from "../repositories/attachment-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import {
	AttachmentImageInspectionError,
	type AttachmentImageMimeType,
	detectAttachmentImageMimeType,
} from "./attachment-image-inspector.ts";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface UploadAttachmentInput {
	readonly sessionId: SessionId;
	readonly name: string;
	readonly mimeType?: string;
	readonly expectedSize?: number;
	readonly content: AsyncIterable<Uint8Array>;
	readonly signal?: AbortSignal;
}

export interface AttachmentServiceOptions {
	readonly attachments: AttachmentRepository;
	readonly sessions: SessionRepository;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly lifecycle: SessionLifecycleCoordinator;
	readonly attachmentBaseDir?: string;
}

export interface AttachmentContent {
	readonly attachment: Attachment;
	readonly mimeType: AttachmentImageMimeType;
	readonly size: number;
	readonly modifiedAt: number;
	readonly body: ReadableStream<Uint8Array>;
	close(): Promise<void>;
}

export class AttachmentService {
	readonly #attachments: AttachmentRepository;
	readonly #sessions: SessionRepository;
	readonly #clock: Clock;
	readonly #ids: IdGenerator;
	readonly #lifecycle: SessionLifecycleCoordinator;
	readonly #baseDir: string;
	readonly #sessionsDir: string;

	constructor(options: AttachmentServiceOptions) {
		this.#attachments = options.attachments;
		this.#sessions = options.sessions;
		this.#clock = options.clock;
		this.#ids = options.ids;
		this.#lifecycle = options.lifecycle;
		this.#baseDir = resolve(options.attachmentBaseDir ?? process.cwd());
		this.#sessionsDir = join(this.#baseDir, "attachments", "sessions");
	}

	async upload(input: UploadAttachmentInput): Promise<Attachment> {
		const lease = this.#lifecycle.acquireUse(input.sessionId, "attachment_upload");
		try {
			await this.#requireSession(input.sessionId);
			const requestedName = validateAttachmentName(input.name);
			const mimeType = normalizeMimeType(input.mimeType);
			validateExpectedSize(input.expectedSize);

			const id = this.#ids.next();
			const sessionDirectory = await this.#ensureSessionDirectory(input.sessionId);
			const temporaryPath = join(sessionDirectory, `.pi-attachment-${id}.tmp`);
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			let publishedPath: string | undefined;
			try {
				throwIfAborted(input.signal);
				handle = await open(temporaryPath, "wx", 0o600);
				const size = await writeContent(handle, input.content, input.signal);
				await handle.close();
				handle = undefined;
				if (input.expectedSize !== undefined && size !== input.expectedSize) {
					throw new AttachmentError(
						"attachment_size_mismatch",
						"Attachment size does not match Content-Length",
						400,
					);
				}
				const published = await this.#publishWithAvailableName(
					input.sessionId,
					requestedName,
					temporaryPath,
					sessionDirectory,
				);
				publishedPath = published.path;
				const attachment: Attachment = {
					id,
					sessionId: input.sessionId,
					name: published.name,
					mimeType,
					size,
					storagePath: posix.join("attachments", "sessions", input.sessionId, published.name),
					createdAt: this.#clock.now(),
				};
				await rm(temporaryPath, { force: true });
				await this.#attachments.insert(attachment);
				return attachment;
			} catch (error) {
				await handle?.close().catch(() => undefined);
				await rm(temporaryPath, { force: true }).catch(() => undefined);
				if (publishedPath !== undefined) await rm(publishedPath, { force: true }).catch(() => undefined);
				if (error instanceof AttachmentError) throw error;
				if (input.signal?.aborted) {
					throw new AttachmentError("attachment_upload_cancelled", "Attachment upload was cancelled", 499);
				}
				throw new AttachmentError(
					"attachment_storage_unavailable",
					"Attachment storage is unavailable",
					500,
					undefined,
					error,
				);
			}
		} finally {
			lease.release();
		}
	}

	async list(sessionId: SessionId): Promise<Attachment[]> {
		await this.#requireSession(sessionId);
		return this.#attachments.listBySessionId(sessionId);
	}

	async openContent(sessionId: SessionId, attachmentId: string, signal?: AbortSignal): Promise<AttachmentContent> {
		await this.#requireSession(sessionId);
		const [attachment] = await this.#attachments.findBySessionIdAndIds(sessionId, [attachmentId]);
		if (attachment === undefined) {
			throw new AttachmentError("attachment_not_found", "Attachment was not found in this Session", 404);
		}
		throwIfContentAborted(signal);
		const expectedStoragePath = posix.join("attachments", "sessions", attachment.sessionId, attachment.name);
		if (attachment.storagePath !== expectedStoragePath || attachment.size > MAX_ATTACHMENT_BYTES) {
			throw new AttachmentError("attachment_changed", "Attachment changed after upload", 409);
		}
		let handle: FileHandle | undefined;
		try {
			await this.#assertSessionDirectory(attachment.sessionId);
			const path = join(this.#baseDir, ...attachment.storagePath.split("/"));
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size !== attachment.size || stat.size > MAX_ATTACHMENT_BYTES) {
				throw new AttachmentError("attachment_changed", "Attachment changed after upload", 409);
			}
			const mimeType = await detectAttachmentImageMimeType(handle, stat.size);
			const stream = handle.createReadStream({ autoClose: true, start: 0, signal });
			const openedHandle = handle;
			handle = undefined;
			return {
				attachment,
				mimeType,
				size: stat.size,
				modifiedAt: stat.mtimeMs,
				body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
				close: async () => {
					stream.destroy();
					await openedHandle.close().catch(() => undefined);
				},
			};
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if (error instanceof AttachmentError) throw error;
			if (error instanceof AttachmentImageInspectionError) {
				throw new AttachmentError(
					error.code === "format_unsupported"
						? "attachment_image_format_unsupported"
						: "attachment_content_invalid",
					error.message,
					415,
				);
			}
			if (signal?.aborted) {
				throw new AttachmentError("attachment_content_cancelled", "Attachment content request was cancelled", 499);
			}
			throw new AttachmentError(
				"attachment_storage_unavailable",
				"Attachment storage is unavailable",
				500,
				undefined,
				error,
			);
		}
	}

	async cleanupSession(sessionId: SessionId): Promise<void> {
		if (!isSafePathSegment(sessionId)) return;
		await rm(join(this.#sessionsDir, sessionId), { recursive: true, force: true });
	}

	async #requireSession(sessionId: SessionId): Promise<void> {
		if (!(await this.#sessions.findById(sessionId))) {
			throw new AttachmentError("attachment_not_found", "Attachment Session was not found", 404);
		}
	}

	async #ensureSessionDirectory(sessionId: SessionId): Promise<string> {
		if (!isSafePathSegment(sessionId)) {
			throw new AttachmentError("attachment_storage_unavailable", "Attachment storage is unavailable", 500);
		}
		try {
			await ensureDirectory(this.#baseDir);
			await ensureDirectory(join(this.#baseDir, "attachments"));
			await ensureDirectory(this.#sessionsDir);
			const sessionDirectory = join(this.#sessionsDir, sessionId);
			await ensureDirectory(sessionDirectory);
			return sessionDirectory;
		} catch (error) {
			if (error instanceof AttachmentError) throw error;
			throw new AttachmentError(
				"attachment_storage_unavailable",
				"Attachment storage is unavailable",
				500,
				undefined,
				error,
			);
		}
	}

	async #assertSessionDirectory(sessionId: SessionId): Promise<void> {
		if (!isSafePathSegment(sessionId)) {
			throw new AttachmentError("attachment_storage_unavailable", "Attachment storage is unavailable", 500);
		}
		for (const path of [
			this.#baseDir,
			join(this.#baseDir, "attachments"),
			this.#sessionsDir,
			join(this.#sessionsDir, sessionId),
		]) {
			const entry = await lstat(path);
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw new AttachmentError("attachment_storage_unavailable", "Attachment storage is unavailable", 500);
			}
		}
	}

	async #publishWithAvailableName(
		sessionId: SessionId,
		requestedName: string,
		temporaryPath: string,
		sessionDirectory: string,
	): Promise<{ name: string; path: string }> {
		for (let suffix = 0; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
			const name = availableAttachmentName(requestedName, suffix);
			if (await this.#attachments.findBySessionIdAndName(sessionId, name)) continue;
			const path = join(sessionDirectory, name);
			try {
				await link(temporaryPath, path);
				return { name, path };
			} catch (error) {
				if (isErrno(error, "EEXIST")) continue;
				throw error;
			}
		}
		throw new AttachmentError("attachment_storage_unavailable", "Attachment name space is exhausted", 500);
	}
}

async function writeContent(
	handle: Awaited<ReturnType<typeof open>>,
	content: AsyncIterable<Uint8Array>,
	signal?: AbortSignal,
): Promise<number> {
	let size = 0;
	for await (const chunk of content) {
		throwIfAborted(signal);
		if (chunk.byteLength === 0) continue;
		size += chunk.byteLength;
		if (size > MAX_ATTACHMENT_BYTES) {
			throw new AttachmentError("attachment_too_large", "Attachment exceeds the 20 MiB limit", 413, "file");
		}
		let offset = 0;
		while (offset < chunk.byteLength) {
			const result = await handle.write(chunk, offset, chunk.byteLength - offset);
			if (result.bytesWritten === 0) {
				throw new Error("Attachment storage made no write progress");
			}
			offset += result.bytesWritten;
		}
	}
	throwIfAborted(signal);
	return size;
}

async function ensureDirectory(path: string): Promise<void> {
	try {
		const entry = await lstat(path);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new AttachmentError("attachment_storage_unavailable", "Attachment storage path is not a directory", 500);
		}
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (mkdirError) {
			if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
			return ensureDirectory(path);
		}
	}
}

function validateAttachmentName(value: string): string {
	if (
		value.length === 0 ||
		value.trim().length === 0 ||
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\") ||
		/[\u0000-\u001f\u007f]/u.test(value) ||
		Buffer.byteLength(value, "utf8") > 255
	) {
		throw new AttachmentError("attachment_name_invalid", "Attachment name is invalid", 400, "name");
	}
	return value;
}

function availableAttachmentName(requestedName: string, suffix: number): string {
	if (suffix === 0) return requestedName;
	const suffixText = `-${suffix}`;
	const extension = posix.extname(requestedName);
	const stem = requestedName.slice(0, requestedName.length - extension.length);
	const reservedBytes = Buffer.byteLength(`${suffixText}${extension}`, "utf8");
	if (reservedBytes < 255) {
		return `${truncateUtf8(stem, 255 - reservedBytes)}${suffixText}${extension}`;
	}
	return `${truncateUtf8(requestedName, 255 - Buffer.byteLength(suffixText, "utf8"))}${suffixText}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function normalizeMimeType(value: string | undefined): string {
	if (value === undefined || value.trim().length === 0) return "application/octet-stream";
	const [mediaType = ""] = value.split(";", 1);
	const normalized = mediaType.trim().toLowerCase();
	if (!/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(normalized)) {
		throw new AttachmentError("attachment_mime_type_invalid", "Attachment MIME type is invalid", 400, "content-type");
	}
	return normalized;
}

function validateExpectedSize(value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new AttachmentError("attachment_size_mismatch", "Content-Length is invalid", 400, "content-length");
	}
	if (value > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentError("attachment_too_large", "Attachment exceeds the 20 MiB limit", 413, "file");
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted)
		throw new AttachmentError("attachment_upload_cancelled", "Attachment upload was cancelled", 499);
}

function throwIfContentAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new AttachmentError("attachment_content_cancelled", "Attachment content request was cancelled", 499);
	}
}

function isSafePathSegment(value: string): boolean {
	return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
