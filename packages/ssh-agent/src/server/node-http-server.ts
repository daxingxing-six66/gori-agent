import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { SshAgentHttpHandler } from "../api/http-handler.ts";
import { backendMessage, formatBackendMessage, resolveBackendLocale } from "../i18n/message.ts";
import { HttpBoundaryError, normalizePublicError } from "../i18n/public-error.ts";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export interface CreateNodeHttpServerOptions {
	handleRequest: SshAgentHttpHandler;
	host: string;
	port: number;
	allowedOrigins?: readonly string[];
	maxRequestBodyBytes?: number;
}

export interface NodeHttpServerAddress {
	host: string;
	port: number;
	origin: string;
}

export interface NodeHttpServer {
	readonly rawServer: Server;
	listen(): Promise<NodeHttpServerAddress>;
	close(): Promise<void>;
}

export function createNodeHttpServer(options: CreateNodeHttpServerOptions): NodeHttpServer {
	const allowedOrigins = new Set(options.allowedOrigins ?? []);
	const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
	if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
		throw new Error("maxRequestBodyBytes must be a positive integer");
	}

	const server = createServer((request, response) => {
		void serve(request, response, options.handleRequest, allowedOrigins, maxRequestBodyBytes);
	});
	server.requestTimeout = 0;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	server.on("clientError", (_error, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	});

	return {
		rawServer: server,
		listen: () => listen(server, options.host, options.port),
		close: () => close(server),
	};
}

async function serve(
	incoming: IncomingMessage,
	outgoing: ServerResponse,
	handleRequest: SshAgentHttpHandler,
	allowedOrigins: ReadonlySet<string>,
	maxRequestBodyBytes: number,
): Promise<void> {
	const incomingUrl = new URL(incoming.url ?? "/", "http://ssh-agent.local");
	const requestedLocale =
		(incoming.method ?? "GET") === "GET" && incomingUrl.pathname.endsWith("/events")
			? incomingUrl.searchParams.get("locale")
			: null;
	const variesByLanguage = !requestedLocale?.trim();
	const locale = resolveBackendLocale({
		locale: requestedLocale,
		acceptLanguage:
			typeof incoming.headers["accept-language"] === "string" ? incoming.headers["accept-language"] : null,
	});
	const abort = new AbortController();
	const onDisconnect = () => { if (!outgoing.writableFinished) abort.abort(new Error("HTTP client disconnected")); };
	incoming.once("aborted", onDisconnect);
	outgoing.once("close", onDisconnect);
	try {
		const request = await toWebRequest(incoming, maxRequestBodyBytes, abort.signal);
		const url = new URL(request.url);
		const response =
			request.method === "GET" && url.pathname === "/healthz"
				? Response.json(
						{ status: "ok" },
						{ headers: { "cache-control": "no-store", ...languageHeaders(locale, variesByLanguage) } },
					)
				: request.method === "OPTIONS" && url.pathname.startsWith("/api/")
					? preflightResponse(request, allowedOrigins)
					: await handleRequest(request);
		if (outgoing.destroyed) { await response.body?.cancel(); return; }
		applyCors(request, response.headers, allowedOrigins);
		await writeWebResponse(outgoing, response, request.method === "HEAD");
	} catch (error) {
		if (outgoing.destroyed) return;
		if (outgoing.headersSent) {
			outgoing.destroy(error instanceof Error ? error : undefined);
			return;
		}
		const normalized = normalizePublicError(
			error instanceof RequestBodyTooLargeError
				? new HttpBoundaryError("payload_too_large", 413, backendMessage("common.payload_too_large"))
				: error,
		);
		await writeWebResponse(
			outgoing,
			Response.json(
				{
					error: {
						code: normalized.code,
						message: formatBackendMessage(locale, normalized.message),
						...(normalized.field === undefined ? {} : { field: normalized.field }),
						...(normalized.retryable === undefined ? {} : { retryable: normalized.retryable }),
						...(normalized.details === undefined ? {} : { details: normalized.details }),
					},
				},
				{ status: normalized.status, headers: languageHeaders(locale, variesByLanguage) },
			),
			false,
		);
	} finally {
		incoming.off("aborted", onDisconnect);
		outgoing.off("close", onDisconnect);
	}
}

async function toWebRequest(incoming: IncomingMessage, maxRequestBodyBytes: number, signal: AbortSignal): Promise<Request> {
	const method = incoming.method ?? "GET";
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else {
			headers.set(name, value);
		}
	}
	const url = new URL(incoming.url ?? "/", "http://ssh-agent.local");
	const streaming =
		(method === "PUT" && /^\/api\/workspaces\/[^/]+\/sftp\/transfers\/[^/]+\/content$/u.test(url.pathname)) ||
		(method === "POST" && /^\/api\/sessions\/[^/]+\/attachments$/u.test(url.pathname));
	const body =
		method === "GET" || method === "HEAD"
			? undefined
			: streaming
				? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
				: copyBytesToArrayBuffer(await readRequestBody(incoming, maxRequestBodyBytes));
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
		signal,
		...(body === undefined ? {} : { body, ...(streaming ? { duplex: "half" as const } : {}) }),
	};
	return new Request(url, init);
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function readRequestBody(incoming: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		let settled = false;
		incoming.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.byteLength;
			if (size > maxBytes) {
				settled = true;
				reject(new RequestBodyTooLargeError());
				incoming.resume();
				return;
			}
			chunks.push(chunk);
		});
		incoming.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks));
		});
		incoming.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		incoming.on("aborted", () => {
			if (settled) return;
			settled = true;
			reject(new Error("Request was aborted"));
		});
	});
}

function preflightResponse(request: Request, allowedOrigins: ReadonlySet<string>): Response {
	const locale = resolveBackendLocale({
		acceptLanguage: request.headers.get("accept-language"),
	});
	const origin = request.headers.get("origin");
	if (origin !== null && !allowedOrigins.has(origin)) {
		const normalized = normalizePublicError(
			new HttpBoundaryError("origin_not_allowed", 403, backendMessage("common.origin_not_allowed")),
		);
		return Response.json(
			{
				error: {
					code: normalized.code,
					message: formatBackendMessage(locale, normalized.message),
				},
			},
			{ status: normalized.status, headers: languageHeaders(locale, true) },
		);
	}
	return new Response(null, {
		status: 204,
		headers: {
			...languageHeaders(locale, true),
			"access-control-allow-headers": "content-type",
			"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
			"access-control-max-age": "600",
		},
	});
}

function languageHeaders(locale: "zh-CN" | "en-US", variesByLanguage: boolean): Record<string, string> {
	return { "content-language": locale, ...(variesByLanguage ? { vary: "Accept-Language" } : {}) };
}

function applyCors(request: Request, headers: Headers, allowedOrigins: ReadonlySet<string>): void {
	const origin = request.headers.get("origin");
	if (origin === null || !allowedOrigins.has(origin)) return;
	headers.set("access-control-allow-origin", origin);
	headers.append("vary", "Origin");
}

async function writeWebResponse(outgoing: ServerResponse, response: Response, headOnly: boolean): Promise<void> {
	outgoing.statusCode = response.status;
	response.headers.forEach((value, name) => {
		outgoing.setHeader(name, value);
	});
	if (headOnly || response.body === null) {
		outgoing.end();
		return;
	}
	const reader = response.body.getReader();
	const onClose = () => void reader.cancel(new Error("HTTP client disconnected"));
	outgoing.once("close", onClose);
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			if (!outgoing.write(Buffer.from(result.value))) await once(outgoing, "drain");
		}
		outgoing.end();
	} finally {
		outgoing.removeListener("close", onClose);
		reader.releaseLock();
	}
}

function listen(server: Server, host: string, port: number): Promise<NodeHttpServerAddress> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(port, host, () => {
			server.off("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("HTTP server did not expose a TCP address"));
				return;
			}
			resolve(addressFrom(address));
		});
	});
}

function close(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function addressFrom(address: AddressInfo): NodeHttpServerAddress {
	const host = address.address;
	const urlHost = host.includes(":") ? `[${host}]` : host;
	return { host, port: address.port, origin: `http://${urlHost}:${address.port}` };
}

class RequestBodyTooLargeError extends Error {
	constructor() {
		super("Request body is too large");
		this.name = "RequestBodyTooLargeError";
	}
}
