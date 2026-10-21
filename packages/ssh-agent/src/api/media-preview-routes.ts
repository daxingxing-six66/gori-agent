import { Readable } from "node:stream";
import type { MediaPreviewService } from "../application/services/media-preview-service.ts";

/** Single byte ranges let the browser seek without buffering an entire video in JavaScript. */
export function mediaByteRange(value: string | null, size: number): { start: number; end: number } | null {
	if (value === null) return { start: 0, end: size - 1 };
	const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
	if (!match || (!match[1] && !match[2]) || size === 0) return null;
	if ((match[1] && !Number.isSafeInteger(Number(match[1]))) || (match[2] && !Number.isSafeInteger(Number(match[2])))) return null;
	const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
	const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) return null;
	return { start, end };
}

export async function handleMediaPreviewRoute(service: MediaPreviewService, request: Request, url: URL, segments: readonly string[]): Promise<Response | null> {
	if (segments[1] !== "sessions" || segments[3] !== "media-preview" ||
		!((segments.length === 4 && request.method === "GET") || (segments.length === 5 && segments[4] === "content" && (request.method === "GET" || request.method === "HEAD")))) return null;
	const opened = await service.open(segments[2]!, url.searchParams.get("path") ?? "");
	const { file, metadata } = opened;
	try {
		if (segments.length === 4) {
			await file.close();
			return Response.json(metadata, { headers: { "cache-control": "no-store" } });
		}
		const rangeHeader = request.method === "HEAD" || request.headers.has("if-range") ? null : request.headers.get("range");
		const range = mediaByteRange(rangeHeader, metadata.size);
		const headers: Record<string, string> = {
			"content-type": metadata.mimeType, "accept-ranges": "bytes", "cache-control": "no-store",
			"x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
			"content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
		};
		if (!range) {
			await file.close();
			return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${metadata.size}` } });
		}
		headers["content-length"] = String(Math.max(0, range.end - range.start + 1));
		if (rangeHeader) headers["content-range"] = `bytes ${range.start}-${range.end}/${metadata.size}`;
		if (request.method === "HEAD" || metadata.size === 0) {
			await file.close();
			return new Response(null, { status: rangeHeader ? 206 : 200, headers });
		}
		const stream = file.createReadStream({ ...range, autoClose: true, highWaterMark: 64 * 1024, signal: request.signal });
		return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 1, size: () => 1 } }) as ReadableStream<Uint8Array>, { status: rangeHeader ? 206 : 200, headers });
	} catch (error) { await file.close(); throw error; }
}
