import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import type { Attachment } from "../../domain/attachment.ts";
import { ChatError } from "../../domain/chat.ts";
import { attachmentIdsFromMessage, MAX_CHAT_IMAGE_ATTACHMENTS } from "../../domain/chat-attachment.ts";
import type { AttachmentRepository } from "../repositories/attachment-repository.ts";
import {
	AttachmentImageInspectionError,
	type AttachmentImageMimeType,
	detectAttachmentImageMimeType,
} from "./attachment-image-inspector.ts";
import { MAX_ATTACHMENT_BYTES } from "./attachment-service.ts";

const IMAGE_ATTACHMENT_MARKER = "Image attachment";

interface PreparedImage {
	readonly data: string;
	readonly mimeType: AttachmentImageMimeType;
}

export interface ChatAttachmentServiceOptions {
	readonly attachments: AttachmentRepository;
	readonly attachmentBaseDir?: string;
}

export class ChatAttachmentService {
	readonly #attachments: AttachmentRepository;
	readonly #baseDir: string;
	readonly #sessionsDir: string;

	constructor(options: ChatAttachmentServiceOptions) {
		this.#attachments = options.attachments;
		this.#baseDir = resolve(options.attachmentBaseDir ?? process.cwd());
		this.#sessionsDir = join(this.#baseDir, "attachments", "sessions");
	}

	async validateReferences(
		sessionId: string,
		attachmentIds: readonly string[],
		model: Model<Api>,
		signal?: AbortSignal,
	): Promise<Attachment[]> {
		validateAttachmentIds(attachmentIds);
		if (attachmentIds.length === 0) return [];
		this.requireImageModel(model);
		const attachments = await this.#findOrdered(sessionId, attachmentIds);
		for (const attachment of attachments) await this.#inspectImage(attachment, signal);
		return attachments;
	}

	requireImageModelForContext(model: Model<Api>, messages: readonly AgentMessage[]): void {
		if (messages.some((message) => attachmentIdsFromMessage(message).length > 0)) this.requireImageModel(model);
	}

	async hydrateProviderContext(
		sessionId: string,
		context: Context,
		model: Model<Api>,
		signal?: AbortSignal,
	): Promise<Context> {
		const attachmentIds = uniqueAttachmentIds(context.messages);
		if (attachmentIds.length === 0) return context;
		this.requireImageModel(model);
		const attachments = await this.#findOrdered(sessionId, attachmentIds);
		const prepared = new Map<string, PreparedImage>();
		for (const attachment of attachments) prepared.set(attachment.id, await this.#readImage(attachment, signal));
		return {
			...context,
			messages: context.messages.map((message) => hydrateMessage(message, prepared)),
		};
	}

	compactionProjection(message: AgentMessage, attachments: readonly Attachment[] = []): AgentMessage {
		const attachmentIds = attachmentIdsFromMessage(message);
		if (message.role !== "user" || attachmentIds.length === 0) return message;
		const names = new Map(attachments.map((attachment) => [attachment.id, attachment.name]));
		const markers = attachmentIds.map((id) => `[${IMAGE_ATTACHMENT_MARKER}: ${names.get(id) ?? id}]`).join("\n");
		const text = typeof message.content === "string" ? message.content : textFromContent(message.content);
		return {
			...message,
			content: [
				...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
				{ type: "text", text: markers },
				...attachmentIds.map(() => ({ type: "image" as const, data: "", mimeType: "image/png" })),
			],
		};
	}

	restoreCompactionMessage(message: AgentMessage): AgentMessage {
		const attachmentIds = attachmentIdsFromMessage(message);
		if (message.role !== "user" || attachmentIds.length === 0 || typeof message.content === "string") return message;
		const text = message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.filter((part) => !part.startsWith(`[${IMAGE_ATTACHMENT_MARKER}:`))
			.join("\n");
		return { ...message, content: text };
	}

	private requireImageModel(model: Model<Api>): void {
		if (!model.input.includes("image")) {
			throw new ChatError(
				"chat_model_image_input_unsupported",
				"The selected model does not support image input",
				409,
			);
		}
	}

	async #findOrdered(sessionId: string, attachmentIds: readonly string[]): Promise<Attachment[]> {
		const found = await this.#attachments.findBySessionIdAndIds(sessionId, attachmentIds);
		const byId = new Map(found.map((attachment) => [attachment.id, attachment]));
		const ordered: Attachment[] = [];
		for (const id of attachmentIds) {
			const attachment = byId.get(id);
			if (!attachment) throw new ChatError("chat_attachment_not_found", "Chat Attachment not found", 404);
			ordered.push(attachment);
		}
		return ordered;
	}

	async #inspectImage(attachment: Attachment, signal?: AbortSignal): Promise<PreparedImage["mimeType"]> {
		return this.#withOpenImage(attachment, signal, async (handle, size) =>
			detectAttachmentImageMimeType(handle, size),
		);
	}

	async #readImage(attachment: Attachment, signal?: AbortSignal): Promise<PreparedImage> {
		return this.#withOpenImage(attachment, signal, async (handle, size) => {
			const mimeType = await detectAttachmentImageMimeType(handle, size);
			const parts: string[] = [];
			let carry = Buffer.alloc(0);
			let bytesRead = 0;
			const stream = handle.createReadStream({ autoClose: false, signal });
			for await (const value of stream) {
				throwIfAborted(signal);
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				bytesRead += chunk.length;
				const bytes = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
				const completeLength = bytes.length - (bytes.length % 3);
				if (completeLength > 0) parts.push(bytes.subarray(0, completeLength).toString("base64"));
				carry = bytes.subarray(completeLength);
			}
			if (bytesRead !== size || (await handle.stat()).size !== size) {
				throw new ChatError("chat_attachment_changed", "The Chat Attachment changed after upload", 409);
			}
			if (carry.length > 0) parts.push(carry.toString("base64"));
			return { data: parts.join(""), mimeType };
		});
	}

	async #withOpenImage<T>(
		attachment: Attachment,
		signal: AbortSignal | undefined,
		operation: (handle: FileHandle, size: number) => Promise<T>,
	): Promise<T> {
		throwIfAborted(signal);
		const expectedStoragePath = posix.join("attachments", "sessions", attachment.sessionId, attachment.name);
		if (attachment.storagePath !== expectedStoragePath || attachment.size > MAX_ATTACHMENT_BYTES) {
			throw new ChatError("chat_attachment_changed", "The Chat Attachment changed after upload", 409);
		}
		try {
			await this.#assertDirectoryChain(attachment.sessionId);
			const path = join(this.#baseDir, ...attachment.storagePath.split("/"));
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size !== attachment.size || stat.size > MAX_ATTACHMENT_BYTES) {
					throw new ChatError("chat_attachment_changed", "The Chat Attachment changed after upload", 409);
				}
				return await operation(handle, stat.size);
			} finally {
				await handle.close().catch(() => undefined);
			}
		} catch (error) {
			if (error instanceof ChatError) throw error;
			if (error instanceof AttachmentImageInspectionError) {
				throw new ChatError(
					error.code === "format_unsupported"
						? "chat_attachment_image_format_unsupported"
						: "chat_attachment_content_invalid",
					error.message,
					415,
				);
			}
			throwIfAborted(signal);
			throw new ChatError("chat_attachment_storage_unavailable", "Chat Attachment storage is unavailable", 500);
		}
	}

	async #assertDirectoryChain(sessionId: string): Promise<void> {
		for (const path of [
			this.#baseDir,
			join(this.#baseDir, "attachments"),
			this.#sessionsDir,
			join(this.#sessionsDir, sessionId),
		]) {
			const entry = await lstat(path);
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw new ChatError("chat_attachment_storage_unavailable", "Chat Attachment storage is unavailable", 500);
			}
		}
	}
}

function validateAttachmentIds(attachmentIds: readonly string[]): void {
	if (attachmentIds.length > MAX_CHAT_IMAGE_ATTACHMENTS) {
		throw new ChatError(
			"chat_attachment_limit_exceeded",
			`A Chat message can contain at most ${MAX_CHAT_IMAGE_ATTACHMENTS} image Attachments`,
			400,
		);
	}
	if (attachmentIds.some((id) => id.trim().length === 0) || new Set(attachmentIds).size !== attachmentIds.length) {
		throw new ChatError("chat_attachment_ids_invalid", "Chat Attachment IDs must be non-empty and unique", 400);
	}
}

function uniqueAttachmentIds(messages: readonly Message[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		for (const id of attachmentIdsFromMessage(message)) {
			if (seen.has(id)) continue;
			seen.add(id);
			result.push(id);
		}
	}
	return result;
}

function hydrateMessage(message: Message, prepared: ReadonlyMap<string, PreparedImage>): Message {
	const attachmentIds = attachmentIdsFromMessage(message);
	if (message.role !== "user" || attachmentIds.length === 0) return message;
	const content: Array<TextContent | ImageContent> = [];
	if (typeof message.content === "string") {
		if (message.content.length > 0) content.push({ type: "text", text: message.content });
	} else {
		content.push(...message.content.filter((block): block is TextContent => block.type === "text"));
	}
	for (const id of attachmentIds) {
		const image = prepared.get(id);
		if (!image) throw new ChatError("chat_attachment_not_found", "Chat Attachment not found", 404);
		content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	return { role: "user", content, timestamp: message.timestamp };
}

function textFromContent(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
