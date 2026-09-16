import type { FileHandle } from "node:fs/promises";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export type AttachmentImageMimeType = "image/jpeg" | "image/png" | "image/webp";
export type AttachmentImageInspectionErrorCode = "content_invalid" | "format_unsupported";

export class AttachmentImageInspectionError extends Error {
	readonly code: AttachmentImageInspectionErrorCode;

	constructor(code: AttachmentImageInspectionErrorCode, message: string) {
		super(message);
		this.name = "AttachmentImageInspectionError";
		this.code = code;
	}
}

export async function detectAttachmentImageMimeType(
	handle: FileHandle,
	size: number,
): Promise<AttachmentImageMimeType> {
	if (size < 12) throw invalidImage("Attachment is not a valid image");
	const header = await readBytes(handle, Math.min(size, 30), 0);
	if (header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		if (size < 33 || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR") {
			throw invalidImage("Attachment is not a valid PNG image");
		}
		if (header.readUInt32BE(16) === 0 || header.readUInt32BE(20) === 0) {
			throw invalidImage("Attachment is not a valid PNG image");
		}
		return "image/png";
	}
	if (header.subarray(0, JPEG_START.length).equals(JPEG_START)) {
		const tail = await readBytes(handle, 2, size - 2);
		if (!tail.equals(JPEG_END) || !(await hasJpegDimensions(handle, size))) {
			throw invalidImage("Attachment is not a valid JPEG image");
		}
		return "image/jpeg";
	}
	if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") {
		if (header.readUInt32LE(4) + 8 !== size || !hasWebpDimensions(header)) {
			throw invalidImage("Attachment is not a valid WebP image");
		}
		return "image/webp";
	}
	throw new AttachmentImageInspectionError("format_unsupported", "Only JPEG, PNG, and WebP Attachments are supported");
}

async function hasJpegDimensions(handle: FileHandle, size: number): Promise<boolean> {
	let offset = 2;
	while (offset + 4 <= size - 2) {
		const markerPrefix = await readBytes(handle, 2, offset);
		if (markerPrefix[0] !== 0xff) return false;
		const marker = markerPrefix[1] as number;
		offset += 2;
		if (marker === 0xd9 || marker === 0xda) return false;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		const lengthBytes = await readBytes(handle, 2, offset);
		const segmentLength = lengthBytes.readUInt16BE(0);
		if (segmentLength < 2 || offset + segmentLength > size) return false;
		if (isJpegStartOfFrame(marker)) {
			if (segmentLength < 7) return false;
			const dimensions = await readBytes(handle, 5, offset + 2);
			return dimensions.readUInt16BE(1) > 0 && dimensions.readUInt16BE(3) > 0;
		}
		offset += segmentLength;
	}
	return false;
}

function isJpegStartOfFrame(marker: number): boolean {
	return (
		(marker >= 0xc0 && marker <= 0xc3) ||
		(marker >= 0xc5 && marker <= 0xc7) ||
		(marker >= 0xc9 && marker <= 0xcb) ||
		(marker >= 0xcd && marker <= 0xcf)
	);
}

function hasWebpDimensions(header: Buffer): boolean {
	const chunkType = header.toString("ascii", 12, 16);
	if (chunkType === "VP8X" && header.length >= 30) {
		return readUInt24LE(header, 24) + 1 > 0 && readUInt24LE(header, 27) + 1 > 0;
	}
	if (chunkType === "VP8L" && header.length >= 25) return header[20] === 0x2f;
	if (chunkType === "VP8 " && header.length >= 30) {
		return header[23] === 0x9d && header[24] === 0x01 && header[25] === 0x2a;
	}
	return false;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
	return (buffer[offset] as number) | ((buffer[offset + 1] as number) << 8) | ((buffer[offset + 2] as number) << 16);
}

async function readBytes(handle: FileHandle, length: number, position: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const result = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, result.bytesRead);
}

function invalidImage(message: string): AttachmentImageInspectionError {
	return new AttachmentImageInspectionError("content_invalid", message);
}
