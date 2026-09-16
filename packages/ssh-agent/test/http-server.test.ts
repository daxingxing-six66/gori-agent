import { describe, expect, it, vi } from "vitest";
import { createNodeHttpServer } from "../src/server/node-http-server.ts";
import { createSshAgentServer } from "../src/server/ssh-agent-server.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("SSH Agent Node HTTP server", () => {
	it("serves health and management API requests over TCP", async () => {
		const server = createSshAgentServer({
			databasePath: ":memory:",
			credentialEncryptionKey: new Uint8Array(32).fill(3),
			host: "127.0.0.1",
			port: 0,
			llmModelsFactory: createTestLlmModels,
		});
		try {
			const address = await server.listen();
			const health = await fetch(`${address.origin}/healthz`);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({ status: "ok" });

			const tree = await fetch(`${address.origin}/api/workspace-session-tree`);
			expect(tree.status).toBe(200);
			expect(await tree.json()).toEqual({ workspaces: [] });
		} finally {
			await server.close();
		}
	});

	it("answers allowed CORS preflight requests", async () => {
		const allowedOrigin = "http://localhost:5173";
		const server = createSshAgentServer({
			databasePath: ":memory:",
			credentialEncryptionKey: new Uint8Array(32).fill(4),
			host: "127.0.0.1",
			port: 0,
			allowedOrigins: [allowedOrigin],
			llmModelsFactory: createTestLlmModels,
		});
		try {
			const address = await server.listen();
			const response = await fetch(`${address.origin}/api/workspaces`, {
				method: "OPTIONS",
				headers: { origin: allowedOrigin },
			});
			expect(response.status).toBe(204);
			expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
			expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
			expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
		} finally {
			await server.close();
		}
	});

	it("rejects oversized request bodies before invoking the API", async () => {
		const server = createSshAgentServer({
			databasePath: ":memory:",
			credentialEncryptionKey: new Uint8Array(32).fill(5),
			host: "127.0.0.1",
			port: 0,
			maxRequestBodyBytes: 16,
			llmModelsFactory: createTestLlmModels,
		});
		try {
			const address = await server.listen();
			const response = await fetch(`${address.origin}/api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ displayName: "too large" }),
			});
			expect(response.status).toBe(413);
			expect(response.headers.get("content-language")).toBe("zh-CN");
			expect(response.headers.get("vary")).toContain("Accept-Language");
			expect(await response.json()).toEqual({
				error: { code: "payload_too_large", message: "请求体过大" },
			});
		} finally {
			await server.close();
		}
	});

	it("hides unexpected Node adapter errors behind a localized error id", async () => {
		const server = createNodeHttpServer({
			host: "127.0.0.1",
			port: 0,
			handleRequest: () => {
				throw new Error("database password leaked");
			},
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const address = await server.listen();
			const response = await fetch(`${address.origin}/api/workspaces`, {
				headers: { "accept-language": "en-US" },
			});
			expect(response.status).toBe(500);
			expect(response.headers.get("content-language")).toBe("en-US");
			const body = (await response.json()) as {
				error: { code: string; message: string; details: { errorId: string } };
			};
			expect(body.error).toMatchObject({
				code: "internal_error",
				message: "Internal server error",
				details: { errorId: expect.any(String) },
			});
			expect(JSON.stringify(body)).not.toContain("database password leaked");
		} finally {
			consoleError.mockRestore();
			await server.close();
		}
	});

	it("streams transfer content larger than the JSON body limit in both directions", async () => {
		let uploadedBytes = 0;
		const responseChunk = new Uint8Array(512 * 1024).fill(7);
		const server = createNodeHttpServer({
			host: "127.0.0.1",
			port: 0,
			maxRequestBodyBytes: 16,
			handleRequest: async (request) => {
				if (request.method === "PUT") {
					if (request.body === null) throw new Error("missing stream");
					const reader = request.body.getReader();
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						uploadedBytes += chunk.value.byteLength;
					}
					return Response.json({ uploadedBytes });
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (let index = 0; index < 5; index += 1) controller.enqueue(responseChunk);
							controller.close();
						},
					}),
				);
			},
		});
		try {
			const address = await server.listen();
			const path = "/api/workspaces/ws-1/sftp/transfers/transfer-1/content";
			const payload = new Uint8Array(3 * 1024 * 1024).fill(3);
			const upload = await fetch(`${address.origin}${path}`, { method: "PUT", body: payload });
			expect(upload.status).toBe(200);
			expect(uploadedBytes).toBe(payload.byteLength);
			const download = await fetch(`${address.origin}${path}`);
			expect((await download.arrayBuffer()).byteLength).toBe(responseChunk.byteLength * 5);
		} finally {
			await server.close();
		}
	});
});
