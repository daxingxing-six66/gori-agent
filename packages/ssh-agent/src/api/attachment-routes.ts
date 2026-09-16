import { createHash } from "node:crypto";
import type { AttachmentService } from "../application/services/attachment-service.ts";
import { AttachmentError } from "../domain/attachment.ts";
import { attachmentResponse } from "./attachment-projection.ts";

export async function handleAttachmentRoute(
	attachments: AttachmentService,
	request: Request,
	url: URL,
	segments: readonly string[],
): Promise<Response | null> {
	if (segments[1] !== "sessions" || segments[3] !== "attachments") return null;
	const sessionId = segments[2] as string;
	if (segments.length === 6 && segments[5] === "content" && request.method === "GET") {
		return contentResponse(attachments, request, sessionId, segments[4] as string);
	}
	if (segments.length !== 4) return null;
	if (request.method === "GET") {
		return json({
			attachments: (await attachments.list(sessionId)).map((attachment) => attachmentResponse(attachment)),
		});
	}
	if (request.method === "POST") {
		const name = url.searchParams.get("name");
		if (name === null) {
			throw new AttachmentError("attachment_name_invalid", "Attachment name is required", 400, "name");
		}
		return json(
			attachmentResponse(
				await attachments.upload({
					sessionId,
					name,
					mimeType: request.headers.get("content-type") ?? undefined,
					expectedSize: contentLength(request.headers.get("content-length")),
					content: requestBody(request.body),
					signal: request.signal,
				}),
			),
			201,
		);
	}
	return null;
}

async function contentResponse(
	attachments: AttachmentService,
	request: Request,
	sessionId: string,
	attachmentId: string,
): Promise<Response> {
	const content = await attachments.openContent(sessionId, attachmentId, request.signal);
	const etag = attachmentEtag(content.attachment.id, content.size, content.modifiedAt);
	const cacheHeaders = {
		"cache-control": "private, max-age=31536000, immutable",
		etag,
		"x-content-type-options": "nosniff",
	};
	if (etagMatches(request.headers.get("if-none-match"), etag)) {
		await content.close();
		return new Response(null, { status: 304, headers: cacheHeaders });
	}
	return new Response(content.body, {
		headers: {
			...cacheHeaders,
			"content-type": content.mimeType,
			"content-length": String(content.size),
			"content-disposition": `inline; filename*=UTF-8''${encodeRfc5987(content.attachment.name)}`,
		},
	});
}

function attachmentEtag(id: string, size: number, modifiedAt: number): string {
	const value = createHash("sha256").update(`${id}\0${size}\0${modifiedAt}`).digest("base64url");
	return `"${value}"`;
}

function etagMatches(value: string | null, etag: string): boolean {
	if (value === null) return false;
	return value.split(",").some((candidate) => {
		const normalized = candidate.trim();
		return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
	});
}

function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(
		/['()*]/gu,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function contentLength(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number(value);
	if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed)) {
		throw new AttachmentError("attachment_size_mismatch", "Content-Length is invalid", 400, "content-length");
	}
	return parsed;
}

async function* requestBody(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
	if (body === null) return;
	const reader = body.getReader();
	let completed = false;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				completed = true;
				return;
			}
			yield result.value;
		}
	} finally {
		if (!completed) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
