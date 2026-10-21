import { localPathIdentity } from "@/shared/files/local-path";

export type MediaKind = "image" | "audio" | "video";
export interface MediaFile { path: string; name: string; kind: MediaKind; mimeType: string; size: number; modifiedAt: number }
export interface MediaDocument { id: string; path: string; name: string; revision: number }

const extensions: Record<MediaKind, readonly string[]> = {
	image: ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "ico", "svg"],
	video: ["mp4", "m4v", "webm", "mov", "ogv"],
	audio: ["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac"],
};

/** Routing hint only. The server owns file access and the actual response MIME type. */
export function mediaKind(path: string): MediaKind | null {
	const name = path.split(/[\\/]/u).at(-1) ?? "";
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	return (Object.keys(extensions) as MediaKind[]).find((kind) => extensions[kind].includes(extension)) ?? null;
}

export function mediaDocument(path: string, workDir?: string | null): MediaDocument {
	const normalized = localPathIdentity(path, workDir);
	return { id: `media:${normalized}`, path: normalized, name: normalized.split("/").at(-1) || normalized, revision: 0 };
}
