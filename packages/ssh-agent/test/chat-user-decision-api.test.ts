import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

const questions = [
	{ question: "Which route?", options: [
		{ label: "A", description: "First" }, { label: "B", description: "Second" },
		{ label: "C", description: "Third" },
	], recommendedIndex: 1 },
	{ question: "Any detail?", options: [
		{ label: "None", description: "No detail" }, { label: "Short", description: "A short detail" },
		{ label: "Long", description: "A long detail" },
	], recommendedIndex: 0 },
];

describe("ask_user_decision HTTP flow", () => {
	it.each(["steer", "follow_up"] as const)("cancels a waiting decision without consuming a queued %s message", async (behavior) => {
		const localCwd = await mkdtemp(join(tmpdir(), "gori-decision-cancel-"));
		const faux = fauxProvider({ provider: "cancel-decision", models: [{ id: "model" }] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_user_decision", { questions }), { stopReason: "toolUse" }),
			fauxAssistantMessage("This reply must not run after cancellation"),
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 26), localCwd,
			llmModelsFactory: (credentials) => { const models = createModels({ credentials }); models.setProvider(faux.provider); return models; },
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
				credential: { displayName: "test", remoteUser: "test", type: "password", password: "test" }, defaultCwd: "/tmp",
			});
			const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, { displayName: "cancel" });
			const sessionId = (session.body as { id: string }).id;
			const root = `/api/sessions/${sessionId}/chat`;
			const created = await json(backend.handleRequest, "POST", `${root}/runs`, {
				requestId: "cancel", providerId: "cancel-decision", modelId: "model", message: "Wait for my decision", serverInteractionMode: "command",
			});
			const runId = (created.body as { id: string }).id;
			await waitFor(async () => ((await json(backend.handleRequest, "GET", `${root}/decisions`)).body as { decisions: unknown[] }).decisions.length > 0);
			const queued = await json(backend.handleRequest, "POST", `${root}/runs/${runId}/queue`, {
				requestId: "queued", behavior, message: "queued-message-must-remain-unsent",
			});
			expect(queued.status).toBe(201);
			await json(backend.handleRequest, "POST", `${root}/runs/${runId}/cancel`);
			await waitFor(async () => (await json(backend.handleRequest, "GET", `${root}/runs/active`)).body.run === null);
			expect(backend.database.prepare("SELECT status, failure_json FROM chat_runs WHERE id = ? AND session_id = ?").get(runId, sessionId))
				.toMatchObject({ status: "cancelled", failure_json: null });
			const messages = await json(backend.handleRequest, "GET", `${root}/messages`);
			expect(JSON.stringify(messages.body)).not.toContain("queued-message-must-remain-unsent");
			expect((await json(backend.handleRequest, "GET", `${root}/runs/${runId}/queue?status=cancelled`)).body.items).toHaveLength(1);
		} finally { await backend.close(); await rm(localCwd, { recursive: true, force: true }); }
	});

	it("recovers a pending model tool call and delivers the user's ordered answers to the same Run", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "gori-decision-api-"));
		const faux = fauxProvider({ provider: "decision-faux", models: [{ id: "model", contextWindow: 128_000, maxTokens: 8_192 }] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_user_decision", { questions }), { stopReason: "toolUse" }),
			fauxAssistantMessage("I will use your chosen route and custom detail."),
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 25), localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" }, defaultCwd: "/tmp",
			});
			const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, { displayName: "chat" });
			const sessionId = (session.body as { id: string }).id;
			const run = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "decision-1", providerId: "decision-faux", modelId: "model", message: "Ask me to decide", serverInteractionMode: "command",
			});
			expect(run.status).toBe(201);
			const runId = (run.body as { id: string }).id;
			let decision: { id: string; runId: string; questions: unknown[] } | undefined;
			await waitFor(async () => {
				const pending = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/decisions`);
				decision = (pending.body as { decisions: typeof decision[] }).decisions[0];
				return decision !== undefined;
			});
			expect(decision).toMatchObject({ runId, questions });
			const answers = [{ kind: "option", optionIndex: 1 }, { kind: "custom", text: "Use YAML" }];
			expect((await json(backend.handleRequest, "POST", `/api/sessions/other/chat/decisions/${decision!.id}/answer`, { answers })).status).toBe(404);
			expect((await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/decisions/${decision!.id}/answer`, { answers: [{ kind: "skipped" }] })).status).toBe(400);
			const answered = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/decisions/${decision!.id}/answer`, { answers });
			expect(answered).toMatchObject({ status: 200, body: { status: "answered", answers } });
			expect(await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/decisions/${decision!.id}/answer`, { answers })).toEqual(answered);
			expect((await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/decisions/${decision!.id}/answer`, { answers: [{ kind: "skipped" }, { kind: "skipped" }] })).status).toBe(409);
			await waitFor(async () => (await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`)).body?.run === null);
			const messages = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages`);
			const text = JSON.stringify(messages.body);
			expect(text).toContain('"label":"B"');
			expect(text).toContain("Use YAML");
			expect(text).toContain("I will use your chosen route");
			expect((await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/decisions`)).body).toEqual({ decisions: [] });
		} finally {
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});
});

async function json(handler: (request: Request) => Promise<Response>, method: string, path: string, body?: unknown) {
	const response = await handler(new Request(`http://localhost${path}`, {
		method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	}));
	return { status: response.status, body: await response.json() };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for a decision Run");
}
