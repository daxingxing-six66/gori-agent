import { extname } from "node:path";

export type MediaKind = "image" | "video" | "audio";
export interface MediaPreviewFile {
	path: string;
	name: string;
	kind: MediaKind;
	mimeType: string;
	size: number;
	modifiedAt: number;
}

const formats: Readonly<Record<string, readonly [MediaKind, string]>> = {
	jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], png: ["image", "image/png"],
	webp: ["image", "image/webp"], gif: ["image", "image/gif"], avif: ["image", "image/avif"],
	bmp: ["image", "image/bmp"], ico: ["image", "image/x-icon"], svg: ["image", "image/svg+xml"],
	mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"],
	mov: ["video", "video/quicktime"], ogv: ["video", "video/ogg"],
	mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"], ogg: ["audio", "audio/ogg"],
	oga: ["audio", "audio/ogg"], opus: ["audio", "audio/ogg"], flac: ["audio", "audio/flac"],
	m4a: ["audio", "audio/mp4"], aac: ["audio", "audio/aac"],
};

export function mediaFormat(path: string): { kind: MediaKind; mimeType: string } | undefined {
	const extension = extname(path).slice(1).toLowerCase();
	const format = Object.hasOwn(formats, extension) ? formats[extension] : undefined;
	return format ? { kind: format[0], mimeType: format[1] } : undefined;
}
