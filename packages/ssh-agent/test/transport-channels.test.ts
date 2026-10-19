import { Agent, get, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createNodeHttpServer } from "../src/server/node-http-server.ts";
import { createSshAgentServer } from "../src/server/ssh-agent-server.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

function serverOptions() {
	return {
		databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 3),
		host: "127.0.0.1", port: 0, eventsPort: 0, llmModelsFactory: createTestLlmModels,
		allowedOrigins: ["http://localhost:3000"],
	};
}

describe("REST and events transport channels", () => {
	it("keeps history and model requests responsive with six persistent event connections", async () => {
		const server = createSshAgentServer(serverOptions());
		const agent = new Agent({ keepAlive: true, maxSockets: 6 });
		try {
			const address = await server.listen();
			const created = await fetch(`${address.origin}/api/workspaces`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ displayName: "test", environment: "development", defaultCwd: "/tmp",
					host: { hostname: "localhost", port: 22 },
					credential: { displayName: "test", remoteUser: "test", type: "password", password: "test" } }),
			});
			expect(created.status).toBe(201);
			const { workspace } = await created.json() as { workspace: { id: string } };
			const sessionResponse = await fetch(`${address.origin}/api/workspaces/${workspace.id}/sessions`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "test" }),
			});
			expect(sessionResponse.status).toBe(201);
			const session = await sessionResponse.json() as { id: string };
			const streams = await Promise.all(Array.from({ length: 6 }, () => openStream(`${address.events.origin}/api/session-activity/events`, agent)));
			expect(streams.every((stream) => stream.statusCode === 200 && !stream.complete)).toBe(true);
			expect(Object.values(agent.sockets).flat()).toHaveLength(6);

			const [history, models] = await Promise.all([
				readJson(`${address.origin}/api/sessions/${session.id}/chat/messages`, agent),
				readJson(`${address.origin}/api/llm/providers`, agent),
			]);
			expect(history).toMatchObject({ messages: [] });
			expect(models).toMatchObject({ providers: expect.any(Array) });
			expect(streams.every((stream) => !stream.complete)).toBe(true);

			// Closing the one backend drains both listeners, including all open event subscriptions.
			await server.close();
			await expect(fetch(`${address.origin}/healthz`)).rejects.toThrow();
			await expect(fetch(`${address.events.origin}/healthz`)).rejects.toThrow();
		} finally {
			agent.destroy();
			await server.close();
		}
	});

	it("enforces channel boundaries while preserving event CORS and health checks", async () => {
		const server = createSshAgentServer(serverOptions());
		try {
			const address = await server.listen();
			expect(address.port).not.toBe(address.events.port);
			for (const origin of [address.origin, address.events.origin]) {
				expect((await fetch(`${origin}/healthz`)).status).toBe(200);
			}
			for (const [origin, path, method] of [
				[address.origin, "/api/session-activity/events", "GET"],
				[address.origin, "/api/workspaces/unknown/events", "GET"],
				[address.origin, "/api/sessions/s/chat/runs/r/events", "GET"],
				[address.origin, "/api/sessions/s/terminal/attachments/a/events", "GET"],
				[address.events.origin, "/api/llm/providers", "GET"],
				[address.events.origin, "/api/workspaces", "POST"],
				[address.events.origin, "/api/session-activity/events", "POST"],
			] as const) {
				const response = await fetch(`${origin}${path}`, { method });
				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
			}
			const stream = await fetch(`${address.events.origin}/api/session-activity/events`, { headers: { origin: "http://localhost:3000" } });
			expect(stream.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
			expect(stream.headers.get("content-type")).toBe("text/event-stream");
			await stream.body!.cancel();
		} finally { await server.close(); }
	});

	it("releases the API listener when the events listener cannot bind", async () => {
		const probe = createNodeHttpServer({ host: "127.0.0.1", port: 0, handleRequest: async () => new Response(null) });
		const occupied = createNodeHttpServer({ host: "127.0.0.1", port: 0, handleRequest: async () => new Response(null) });
		const api = await probe.listen();
		await probe.close();
		const events = await occupied.listen();
		const failed = createSshAgentServer({ ...serverOptions(), port: api.port, eventsPort: events.port });
		const replacement = createNodeHttpServer({ host: "127.0.0.1", port: api.port, handleRequest: async () => new Response(null) });
		try {
			await expect(failed.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
			await expect(replacement.listen()).resolves.toMatchObject({ port: api.port });
		} finally { await failed.close(); await replacement.close(); await occupied.close(); }
	});

	it("rejects shared ports before starting a backend", () => {
		expect(() => createSshAgentServer({ ...serverOptions(), port: 4001, eventsPort: 4001 })).toThrow("must differ");
	});
});

function openStream(url: string, agent: Agent): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const request = get(url, { agent }, (response) => {
			response.on("error", reject);
			response.once("data", (chunk: Buffer) => {
				if (!chunk.toString().includes("activity.snapshot")) { reject(new Error("Missing initial snapshot")); return; }
				resolve(response);
			});
		});
		request.on("error", reject);
	});
}

function readJson(url: string, agent: Agent): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = get(url, { agent, signal: AbortSignal.timeout(2000) }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("error", reject);
			response.on("end", () => {
				if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
				try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
			});
		});
		request.on("error", reject);
	});
}
