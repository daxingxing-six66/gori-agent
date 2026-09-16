import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IdGenerator } from "../src/domain/ids.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createNodeHttpServer } from "../src/server/node-http-server.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Session Attachment API", () => {
	it("uploads raw bytes, persists metadata, and lists attachments after restart", async () => {
		const directory = await temporaryDirectory();
		const databasePath = join(directory, "ssh-agent.sqlite");
		let backend = createBackend(directory, databasePath);
		try {
			const sessionId = await createSession(backend.handleRequest);
			const response = await backend.handleRequest(
				new Request(
					`http://localhost/api/sessions/${sessionId}/attachments?name=${encodeURIComponent("报告.txt")}`,
					{
						method: "POST",
						headers: { "content-type": "text/plain; charset=utf-8", "content-length": "5" },
						body: new Uint8Array([1, 2, 3, 4, 5]),
					},
				),
			);
			expect(response.status).toBe(201);
			const uploaded = (await response.json()) as {
				id: string;
				name: string;
				storagePath: string;
				contentUrl: string;
				mimeType: string;
				size: number;
			};
			expect(uploaded).toMatchObject({
				mimeType: "text/plain",
				size: 5,
				storagePath: `attachments/sessions/${sessionId}/报告.txt`,
				contentUrl: `/api/sessions/${sessionId}/attachments/${uploaded.id}/content`,
			});
			expect(await readFile(join(directory, uploaded.storagePath))).toEqual(Buffer.from([1, 2, 3, 4, 5]));

			await backend.close();
			backend = createBackend(directory, databasePath);
			const listed = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/attachments`);
			expect(listed).toMatchObject({
				status: 200,
				body: {
					attachments: [
						{
							id: uploaded.id,
							name: "报告.txt",
							size: 5,
							contentUrl: `/api/sessions/${sessionId}/attachments/${uploaded.id}/content`,
						},
					],
				},
			});
		} finally {
			await backend.close();
		}
	});

	it("renames duplicate uploads and returns stable localized size errors", async () => {
		const directory = await temporaryDirectory();
		const backend = createBackend(directory);
		try {
			const sessionId = await createSession(backend.handleRequest);
			const path = `/api/sessions/${sessionId}/attachments?name=file.bin`;
			const first = await upload(backend.handleRequest, path, new Uint8Array([1]));
			expect(first.status).toBe(201);
			const duplicate = await upload(backend.handleRequest, path, new Uint8Array([2]), {
				"accept-language": "en-US",
			});
			expect(duplicate).toMatchObject({
				status: 201,
				body: { name: "file-1.bin", storagePath: `attachments/sessions/${sessionId}/file-1.bin` },
			});

			const mismatch = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${sessionId}/attachments?name=short.bin`, {
					method: "POST",
					headers: { "content-length": "2", "accept-language": "zh-CN" },
					body: new Uint8Array([1]),
				}),
			);
			expect(mismatch.status).toBe(400);
			expect(await mismatch.json()).toMatchObject({
				error: { code: "attachment_size_mismatch", message: "附件实际大小与 Content-Length 不一致" },
			});
		} finally {
			await backend.close();
		}
	});

	it("streams validated image content with immutable cache headers and supports ETag revalidation", async () => {
		const directory = await temporaryDirectory();
		const backend = createBackend(directory);
		try {
			const sessionId = await createSession(backend.handleRequest);
			const bytes = pngBytes();
			const uploaded = await upload(
				backend.handleRequest,
				`/api/sessions/${sessionId}/attachments?name=${encodeURIComponent("screen shot.png")}`,
				bytes,
				{ "content-type": "application/octet-stream" },
			);
			expect(uploaded.status).toBe(201);
			const attachment = uploaded.body as { id: string; contentUrl: string };
			expect(JSON.stringify(uploaded.body)).not.toContain(directory);
			const response = await backend.handleRequest(new Request(`http://localhost${attachment.contentUrl}`));
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/png");
			expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
			expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''screen%20shot.png");
			const etag = response.headers.get("etag");
			expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

			const notModified = await backend.handleRequest(
				new Request(`http://localhost${attachment.contentUrl}`, { headers: { "if-none-match": etag as string } }),
			);
			expect(notModified.status).toBe(304);
			expect(notModified.headers.get("etag")).toBe(etag);
			expect(await notModified.text()).toBe("");
		} finally {
			await backend.close();
		}
	});

	it("rejects unsupported content and isolates Attachment IDs by Session", async () => {
		const directory = await temporaryDirectory();
		const backend = createBackend(directory);
		try {
			const firstSessionId = await createSession(backend.handleRequest);
			const secondSessionId = await createSession(backend.handleRequest);
			const uploaded = await upload(
				backend.handleRequest,
				`/api/sessions/${firstSessionId}/attachments?name=file.txt`,
				new TextEncoder().encode("not an image"),
			);
			const attachment = uploaded.body as { id: string; contentUrl: string };
			const unsupported = await backend.handleRequest(new Request(`http://localhost${attachment.contentUrl}`));
			expect(unsupported.status).toBe(415);
			expect(await unsupported.json()).toMatchObject({
				error: { code: "attachment_image_format_unsupported" },
			});

			const isolated = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${secondSessionId}/attachments/${attachment.id}/content`),
			);
			expect(isolated.status).toBe(404);
			expect(await isolated.json()).toMatchObject({ error: { code: "attachment_not_found" } });
		} finally {
			await backend.close();
		}
	});

	it("streams above the JSON limit and coordinates upload with Session deletion", async () => {
		const directory = await temporaryDirectory();
		const backend = createBackend(directory);
		const server = createNodeHttpServer({
			host: "127.0.0.1",
			port: 0,
			maxRequestBodyBytes: 16,
			handleRequest: backend.handleRequest,
		});
		try {
			const sessionId = await createSession(backend.handleRequest);
			const address = await server.listen();
			const payload = new Uint8Array(64 * 1024).fill(7);
			const streamed = await fetch(`${address.origin}/api/sessions/${sessionId}/attachments?name=streamed.bin`, {
				method: "POST",
				body: payload,
			});
			expect(streamed.status).toBe(201);
			expect(await streamed.json()).toMatchObject({ size: payload.byteLength });

			let markReading = () => {};
			const reading = new Promise<void>((resolve) => {
				markReading = resolve;
			});
			let releaseContent = () => {};
			const released = new Promise<void>((resolve) => {
				releaseContent = resolve;
			});
			const pendingUpload = backend.attachments.upload({
				sessionId,
				name: "pending.bin",
				content: blockingContent(markReading, released),
			});
			await reading;
			const blockedDelete = await request(
				backend.handleRequest,
				"DELETE",
				`/api/sessions/${sessionId}?expectedRevision=1`,
			);
			expect(blockedDelete).toMatchObject({
				status: 409,
				body: { error: { code: "session_has_active_attachment_upload" } },
			});

			releaseContent();
			await pendingUpload;
			const deleted = await request(
				backend.handleRequest,
				"DELETE",
				`/api/sessions/${sessionId}?expectedRevision=1`,
			);
			expect(deleted.status).toBe(204);
			await expect(access(join(directory, "attachments", "sessions", sessionId))).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await server.close();
			await backend.close();
		}
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "attachment-api-"));
	directories.push(directory);
	return directory;
}

function createBackend(attachmentBaseDir: string, databasePath = ":memory:") {
	return createSqliteManagementBackend({
		databasePath,
		credentialEncryptionKey: new Uint8Array(32).fill(17),
		clock: { now: () => 1_000 },
		ids: new SequentialIds(),
		llmModelsFactory: createTestLlmModels,
		attachmentBaseDir,
	});
}

class SequentialIds implements IdGenerator {
	#next = 1;

	next(): string {
		return `id-${this.#next++}`;
	}
}

async function createSession(handleRequest: (request: Request) => Promise<Response>): Promise<string> {
	const workspace = await request(handleRequest, "POST", "/api/workspaces", {
		displayName: "workspace",
		environment: "development",
		host: { hostname: "localhost", port: 22 },
		credential: {
			displayName: "root",
			remoteUser: "root",
			type: "password",
			password: "password",
		},
		defaultCwd: "/tmp",
	});
	const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
	const session = await request(handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
		displayName: "session",
	});
	return (session.body as { id: string }).id;
}

async function upload(
	handleRequest: (request: Request) => Promise<Response>,
	path: string,
	body: Uint8Array,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
	const response = await handleRequest(
		new Request(`http://localhost${path}`, { method: "POST", headers, body: copyBytesToArrayBuffer(body) }),
	);
	return { status: response.status, body: await response.json() };
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function request(
	handleRequest: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: unknown }> {
	const response = await handleRequest(
		new Request(`http://localhost${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}

async function* blockingContent(onRead: () => void, released: Promise<void>): AsyncIterable<Uint8Array> {
	onRead();
	await released;
	yield new Uint8Array([1]);
}

function pngBytes(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		"base64",
	);
}
