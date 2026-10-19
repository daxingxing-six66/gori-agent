import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

	it("prevents another server from recovering a live deployment, then recovers it after shutdown", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gori-server-owner-"));
		const databasePath = join(directory, "gori.sqlite");
		const options = {
			databasePath,
			credentialEncryptionKey: new Uint8Array(32).fill(3),
			host: "127.0.0.1",
			port: 0,
			llmModelsFactory: createTestLlmModels,
		};
		try {
			const first = createSshAgentServer(options);
			try {
				const address = await first.listen();
				const database = new DatabaseSync(databasePath);
				try {
					insertRunningDeployment(database);
					expect(() => createSshAgentServer(options)).toThrow("Gori database is already in use");
					expect(database.prepare("SELECT status FROM deployment_runs WHERE id = 'deploy-1'").get())
						.toEqual({ status: "running" });
					expect((await fetch(`${address.origin}/healthz`)).status).toBe(200);
				} finally { database.close(); }
			} finally { await first.close(); }
			const restarted = createSshAgentServer(options);
			try {
				await restarted.listen();
				const database = new DatabaseSync(databasePath);
				try {
					expect(database.prepare("SELECT status FROM deployment_runs WHERE id = 'deploy-1'").get())
						.toEqual({ status: "failed" });
				} finally { database.close(); }
			} finally { await restarted.close(); }
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["api", "events"])("keeps ownership across processes and releases it after a failed %s port bind", async (channel) => {
		const directory = await mkdtemp(join(tmpdir(), "gori-server-owner-"));
		const databasePath = join(directory, "gori.sqlite");
		const occupied = createNodeHttpServer({ host: "127.0.0.1", port: 0, handleRequest: async () => new Response(null) });
		try {
			const address = await occupied.listen();
			const options = {
				databasePath,
				credentialEncryptionKey: new Uint8Array(32).fill(3),
				host: "127.0.0.1",
				port: channel === "api" ? address.port : 0,
				eventsPort: channel === "events" ? address.port : 0,
				llmModelsFactory: createTestLlmModels,
			};
			const failed = createSshAgentServer(options);
			expect(childCanOwn(databasePath)).toBe(false);
			await expect(failed.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
			expect(childCanOwn(databasePath)).toBe(true);
			const replacement = createSshAgentServer({ ...options, port: 0, eventsPort: 0 });
			try { await replacement.listen(); }
			finally { await replacement.close(); }
		} finally {
			await occupied.close();
			await rm(directory, { recursive: true, force: true });
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

function childCanOwn(databasePath: string): boolean {
	const script = `import { DatabaseSync } from "node:sqlite";
		const database = new DatabaseSync(process.argv[1]);
		try { database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); database.exec("ROLLBACK"); }
		catch (error) { if (error.errcode === 5) process.exitCode = 1; else { console.error(error); process.exitCode = 2; } }
		finally { database.close(); }`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, `${databasePath}.server-lock.sqlite`]);
	if (result.error) throw result.error;
	if (result.status !== 0 && result.status !== 1) throw new Error(`Lock probe failed: ${result.stderr.toString()}`);
	return result.status === 0;
}

function insertRunningDeployment(database: DatabaseSync): void {
	database.exec(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
		connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
		VALUES ('workspace-1', 'test', 'development', 'example.org', 22, '/srv/api', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, terminal_context_cursor, revision, created_at, updated_at)
		VALUES ('session-1', 'workspace-1', 'test', 0, 1, 1, 1);`);
	const snapshot = {
		id: "deploy-1", sessionId: "session-1", workspaceId: "workspace-1", agentRunId: "agent-1",
		status: "running", createdAt: 1, startedAt: 2, updatedAt: 2,
		plan: {
			profilePath: "/test/deploy.md", profileHash: "hash", remoteAccess: { mode: "workspace_write" },
			project: "test", target: { host: "example.org" },
			targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "credential-1",
				credentialAuthVersion: 1, remoteUser: "test", writableRoot: "/srv/api" },
			module: { id: "api", name: "API" },
			build: { cwd: "/test", command: "true", artifact: "/test/api.jar" },
			upload: { remotePath: "/srv/api/api.jar" }, restart: { command: "true" },
		},
		stages: {
			prepare: { status: "success", log: "" }, build: { status: "running", log: "", startedAt: 2 },
			upload: { status: "pending", log: "" }, restart: { status: "pending", log: "" },
			verify: { status: "pending", log: "" },
		},
	};
	database.prepare(`INSERT INTO deployment_runs (id, session_id, workspace_id, status, snapshot_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`).run(snapshot.id, snapshot.sessionId, snapshot.workspaceId, snapshot.status,
		JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt);
}
