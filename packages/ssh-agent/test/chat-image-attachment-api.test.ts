import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Chat image Attachment API", () => {
	it("sends referenced images to a multimodal model without persisting Base64", async () => {
		const directory = await temporaryDirectory();
		const faux = fauxProvider({
			provider: "chat-image-faux",
			models: [{ id: "vision", input: ["text", "image"], contextWindow: 128_000, maxTokens: 8_192 }],
		});
		const providerContexts: Context[] = [];
		faux.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("described");
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("described");
			},
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 19),
			localCwd: directory,
			attachmentBaseDir: directory,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const sessionId = await createSession(backend.handleRequest);
			const bytes = pngBytes();
			const firstUpload = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${sessionId}/attachments?name=screen.png`, {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: Uint8Array.from(bytes),
				}),
			);
			expect(firstUpload.status).toBe(201);
			const firstAttachment = (await firstUpload.json()) as { id: string };
			const secondUpload = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${sessionId}/attachments?name=second.png`, {
					method: "POST",
					headers: { "content-type": "image/png" },
					body: Uint8Array.from(bytes),
				}),
			);
			expect(secondUpload.status).toBe(201);
			const secondAttachment = (await secondUpload.json()) as { id: string };

			const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "image-run",
				providerId: "chat-image-faux",
				modelId: "vision",
				message: "",
				attachmentIds: [secondAttachment.id, firstAttachment.id],
				serverInteractionMode: "command",
			});
			expect(created.status).toBe(201);
			await waitFor(async () => {
				const active = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (active.body as { run: unknown }).run === null;
			});

			expect(providerContexts[0]?.messages[0]).toEqual({
				role: "user",
				content: [
					{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
					{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
				],
				timestamp: expect.any(Number),
			});

			const reused = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "reuse-image-run",
				providerId: "chat-image-faux",
				modelId: "vision",
				message: "reuse",
				attachmentIds: [firstAttachment.id],
				serverInteractionMode: "command",
			});
			expect(reused.status).toBe(201);
			await waitFor(async () => {
				const active = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (active.body as { run: unknown }).run === null;
			});
			expect(providerContexts[1]?.messages.at(-1)).toEqual({
				role: "user",
				content: [
					{ type: "text", text: "reuse" },
					{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
				],
				timestamp: expect.any(Number),
			});

			const persisted = backend.database
				.prepare(
					"SELECT id, message_json FROM chat_messages WHERE session_id = ? AND message_type = 'user' ORDER BY sequence",
				)
				.all(sessionId) as Array<{ id: string; message_json: string }>;
			expect(JSON.parse(persisted[0]!.message_json)).toMatchObject({
				role: "user",
				content: "",
				attachmentIds: [secondAttachment.id, firstAttachment.id],
			});
			expect(JSON.parse(persisted[1]!.message_json)).toMatchObject({
				attachmentIds: [firstAttachment.id],
			});
			expect(persisted.every((message) => !message.message_json.includes(bytes.toString("base64")))).toBe(true);
			expect(
				backend.database
					.prepare(
						"SELECT attachment_id, ordinal FROM chat_message_attachments WHERE message_id = ? ORDER BY ordinal",
					)
					.all(persisted[0]!.id),
			).toEqual([
				{ attachment_id: secondAttachment.id, ordinal: 0 },
				{ attachment_id: firstAttachment.id, ordinal: 1 },
			]);
			expect(
				backend.database
					.prepare("SELECT COUNT(*) AS count FROM chat_message_attachments WHERE attachment_id = ?")
					.get(firstAttachment.id),
			).toEqual({ count: 2 });

			const listed = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages`);
			expect(JSON.stringify(listed.body)).not.toContain(bytes.toString("base64"));
			const user = (listed.body as { messages: Array<Record<string, unknown>> }).messages.find(
				(message) => (message.message as { role?: string }).role === "user",
			);
			expect(user).toMatchObject({
				message: { attachmentIds: [secondAttachment.id, firstAttachment.id] },
				attachments: [
					{
						id: secondAttachment.id,
						name: "second.png",
						contentUrl: `/api/sessions/${sessionId}/attachments/${secondAttachment.id}/content`,
					},
					{
						id: firstAttachment.id,
						name: "screen.png",
						contentUrl: `/api/sessions/${sessionId}/attachments/${firstAttachment.id}/content`,
					},
				],
			});
			backend.database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
			expect(backend.database.prepare("SELECT COUNT(*) AS count FROM chat_message_attachments").get()).toEqual({
				count: 0,
			});
		} finally {
			await backend.close();
		}
	});

	it("rejects image references for a text-only model before creating the Run", async () => {
		const directory = await temporaryDirectory();
		const faux = fauxProvider({
			provider: "chat-text-faux",
			models: [{ id: "text", input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
		});
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 20),
			localCwd: directory,
			attachmentBaseDir: directory,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const sessionId = await createSession(backend.handleRequest);
			const uploaded = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${sessionId}/attachments?name=screen.png`, {
					method: "POST",
					body: Uint8Array.from(pngBytes()),
				}),
			);
			const attachment = (await uploaded.json()) as { id: string };
			const response = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "text-run",
				providerId: "chat-text-faux",
				modelId: "text",
				message: "inspect",
				attachmentIds: [attachment.id],
				serverInteractionMode: "command",
			});
			expect(response).toMatchObject({
				status: 409,
				body: { error: { code: "chat_model_image_input_unsupported", message: "当前模型不支持图片输入" } },
			});
			expect(backend.database.prepare("SELECT COUNT(*) AS count FROM chat_runs").get()).toEqual({ count: 0 });
		} finally {
			await backend.close();
		}
	});

	it("rejects switching to a text-only model while effective history still references an image", async () => {
		const directory = await temporaryDirectory();
		const faux = fauxProvider({
			provider: "chat-history-image-faux",
			models: [
				{ id: "vision", input: ["text", "image"], contextWindow: 128_000, maxTokens: 8_192 },
				{ id: "text", input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
			],
		});
		faux.setResponses([fauxAssistantMessage("described")]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 21),
			localCwd: directory,
			attachmentBaseDir: directory,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const sessionId = await createSession(backend.handleRequest);
			const uploaded = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${sessionId}/attachments?name=screen.png`, {
					method: "POST",
					body: Uint8Array.from(pngBytes()),
				}),
			);
			const attachment = (await uploaded.json()) as { id: string };
			expect(
				await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
					requestId: "vision-run",
					providerId: "chat-history-image-faux",
					modelId: "vision",
					message: "inspect",
					attachmentIds: [attachment.id],
					serverInteractionMode: "command",
				}),
			).toMatchObject({ status: 201 });
			await waitFor(async () => {
				const active = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (active.body as { run: unknown }).run === null;
			});

			const switched = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "text-run",
				providerId: "chat-history-image-faux",
				modelId: "text",
				message: "continue",
				serverInteractionMode: "command",
			});
			expect(switched).toMatchObject({
				status: 409,
				body: { error: { code: "chat_model_image_input_unsupported" } },
			});
			expect(backend.database.prepare("SELECT COUNT(*) AS count FROM chat_runs").get()).toEqual({ count: 1 });
		} finally {
			await backend.close();
		}
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "chat-image-attachment-api-"));
	directories.push(directory);
	return directory;
}

async function createSession(handleRequest: (request: Request) => Promise<Response>): Promise<string> {
	const workspace = await request(handleRequest, "POST", "/api/workspaces", {
		displayName: "test",
		environment: "development",
		host: { hostname: "localhost", port: 22 },
		credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
		defaultCwd: "/tmp",
	});
	const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
	const session = await request(handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
		displayName: "chat",
	});
	return String((session.body as { id: string }).id);
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

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Chat Run completion");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function pngBytes(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		"base64",
	);
}
