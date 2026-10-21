import { attachmentFileKind, maximumAttachmentUploadBytes, type AttachmentFileKind } from "@/features/session/model/attachment-file";
import { fitImageWithinMaximumDimension, type ImageDimensions } from "@/features/session/model/image-upload";

type AttachmentPreparationFailure = "unsupported" | "tooLarge" | "invalidText" | "imageProcessing";

export class AttachmentPreparationError extends Error {
	readonly reason: AttachmentPreparationFailure;
	constructor(reason: AttachmentPreparationFailure) {
		super(reason);
		this.name = "AttachmentPreparationError";
		this.reason = reason;
	}
}

export interface PreparedChatAttachment {
	file: File;
	kind: AttachmentFileKind;
	dimensions?: ImageDimensions;
}

export async function prepareChatAttachment(file: File, signal?: AbortSignal): Promise<PreparedChatAttachment> {
	signal?.throwIfAborted();
	const kind = attachmentFileKind(file.name, file.type);
	if (!kind) throw new AttachmentPreparationError("unsupported");
	if (kind === "document") {
		if (file.size > maximumAttachmentUploadBytes) throw new AttachmentPreparationError("tooLarge");
		const bytes = await file.arrayBuffer();
		signal?.throwIfAborted();
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			if (/[\x00-\x08\x0e-\x1f]/u.test(text)) throw new Error("Binary control characters");
		} catch {
			throw new AttachmentPreparationError("invalidText");
		}
		return { kind, file };
	}
	let prepared: PreparedChatAttachment;
	try {
		prepared = await prepareImage(file, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new AttachmentPreparationError("imageProcessing");
	}
	if (prepared.file.size > maximumAttachmentUploadBytes) throw new AttachmentPreparationError("tooLarge");
	return prepared;
}

async function prepareImage(file: File, signal?: AbortSignal): Promise<PreparedChatAttachment> {
	const bitmap = await createImageBitmap(file);
	try {
		signal?.throwIfAborted();
		const dimensions = fitImageWithinMaximumDimension(bitmap);
		const inputType = file.type.toLowerCase();
		const directlySupported = inputType === "image/jpeg" || inputType === "image/png" || inputType === "image/webp";
		const resize = dimensions.width !== bitmap.width || dimensions.height !== bitmap.height;
		// Other browser-decodable formats must be normalized even when no resize is necessary.
		if (!resize && directlySupported) return { kind: "image", file, dimensions };
		const outputType = directlySupported ? inputType : "image/png";
		const canvas = document.createElement("canvas");
		canvas.width = dimensions.width;
		canvas.height = dimensions.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Image canvas is unavailable");
		context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
		const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => {
			if (value) resolve(value);
			else reject(new Error("Image encoding failed"));
		}, outputType, outputType === "image/png" ? undefined : 0.9));
		signal?.throwIfAborted();
		const name = outputType === inputType ? file.name : `${file.name.replace(/\.[^.]+$/u, "")}.png`;
		return { kind: "image", file: new File([blob], name, { type: outputType, lastModified: file.lastModified }), dimensions };
	} finally {
		bitmap.close();
	}
}
