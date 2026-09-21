import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTitleService } from "../src/application/services/session-title-service.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

function deferred() {
	let resolve!: (value: AssistantMessage) => void;
	const promise = new Promise<AssistantMessage>((yes) => { resolve = yes; });
	return { promise, resolve };
}

async function setup() {
	const faux = fauxProvider({ provider: "title-provider", models: [{ id: "title-model", contextWindow: 128_000, maxTokens: 8192 }] });
	faux.setResponses([fauxAssistantMessage("Chat answer"), fauxAssistantMessage("Follow-up answer")]);
	const backend = createSqliteManagementBackend({
		databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 12), localCwd: process.cwd(),
		llmModelsFactory: (credentials) => {
			const models = createModels({ credentials }); models.setProvider(faux.provider); return models;
		},
	});
	const workspace = await backend.api.createWorkspace({ displayName: "test", environment: "development",
		host: { hostname: "localhost", port: 22 }, defaultCwd: "/tmp",
		credential: { displayName: "SSH", remoteUser: "test", secret: { type: "password", password: "test" } },
	});
	const session = await backend.api.createSession({ workspaceId: workspace.workspace.id, displayName: "新会话" });
	const repository = new SqliteSessionRepository(backend.database);
	const model = backend.llmModels.getModel("title-provider", "title-model")!;
	return { backend, session, repository, model };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("automatic Session titles", () => {
	it("starts on the first opted-in Run without blocking chat; persists and sends the title after the Run ends", async () => {
		const { backend, session } = await setup();
		const pending = deferred();
		const generate = vi.spyOn(backend.llmModels, "completeSimple").mockReturnValue(pending.promise);
		const stream = await backend.handleRequest(new Request(`http://localhost/api/workspaces/${session.workspaceId}/events?topics=sessions`));
		expect(stream.status).toBe(200);
		const reader = stream.body!.getReader();
		await reader.read(); // stream.ready
		const input = { requestId: "first", generateTitle: true, providerId: "title-provider", modelId: "title-model", message: "分析 SSH 终端漏读问题", serverInteractionMode: "command" };
		const createRun = (body: typeof input) => backend.handleRequest(new Request(`http://localhost/api/sessions/${session.id}/chat/runs`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
		}));
		try {
			const response = await createRun(input);
			expect(response.status).toBe(201);
			const run = await response.json() as { id: string };
			await vi.waitFor(() => expect(backend.database.prepare("SELECT status FROM chat_runs WHERE id = ?").get(run.id)?.status).toBe("completed"));
			expect((await backend.api.getSession(session.id)).displayName).toBe("新会话");
			expect(generate).toHaveBeenCalledOnce();
			expect(generate.mock.calls[0]![0]).toMatchObject({ provider: "title-provider", id: "title-model" });
			expect(generate.mock.calls[0]![1].messages).toHaveLength(1);
			expect(generate.mock.calls[0]![1].tools).toBeUndefined();
			await createRun(input); // HTTP retry must not generate again.
			pending.resolve(fauxAssistantMessage("SSH 终端漏读排查"));
			const event = new TextDecoder().decode((await reader.read()).value);
			expect(event).toContain("event: session.updated");
			expect(event).toContain('"displayName":"SSH 终端漏读排查"');
			expect((await backend.api.getSession(session.id)).displayName).toBe("SSH 终端漏读排查");
			await createRun({ ...input, requestId: "second" });
			expect(generate).toHaveBeenCalledOnce();
			const messages = backend.database.prepare("SELECT * FROM chat_messages WHERE session_id = ?").all(session.id);
			expect(messages.length).toBeGreaterThanOrEqual(2);
			expect(JSON.stringify(messages)).not.toContain("SSH 终端漏读排查");
		} finally {
			await reader.cancel(); await backend.close();
		}
	});

	it("keeps explicitly named sessions unchanged unless the first Run opts in", async () => {
		const { backend, session } = await setup();
		const generate = vi.spyOn(backend.llmModels, "completeSimple");
		try {
			const response = await backend.handleRequest(new Request(`http://localhost/api/sessions/${session.id}/chat/runs`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "manual", providerId: "title-provider", modelId: "title-model", message: "hello", serverInteractionMode: "command" }),
			}));
			expect(response.status).toBe(201);
			expect(generate).not.toHaveBeenCalled();
		} finally { await backend.close(); }
	});

	it("isolates provider failure from the Session", async () => {
		const { backend, session, repository, model } = await setup();
		const completeSimple = vi.fn().mockRejectedValue(new Error("provider unavailable"));
		const events = { publish: vi.fn() };
		const service = new SessionTitleService({ models: { completeSimple }, sessions: repository, events });
		try {
			vi.spyOn(console, "error").mockImplementation(() => {});
			service.start(session, model, "部署服务");
			await new Promise((resolve) => setImmediate(resolve));
			expect(completeSimple).toHaveBeenCalledOnce();
			expect((await repository.findById(session.id))?.displayName).toBe("新会话");
			expect(events.publish).not.toHaveBeenCalled();
		} finally { await service.close(); await backend.close(); }
	});

	it.each(["rename", "delete"] as const)("does not overwrite a concurrent %s", async (action) => {
		const { backend, session, repository, model } = await setup();
		const pending = deferred();
		const events = { publish: vi.fn() };
		const service = new SessionTitleService({ models: { completeSimple: () => pending.promise }, sessions: repository, events });
		try {
			service.start(session, model, "请排查服务部署问题");
			await Promise.resolve();
			if (action === "rename") await backend.api.renameSession({ id: session.id, displayName: "手动标题", expectedRevision: 1 });
			else await backend.api.deleteSession({ id: session.id, expectedRevision: 1 });
			pending.resolve(fauxAssistantMessage("自动标题"));
			await vi.waitFor(async () => {
				const saved = await repository.findById(session.id);
				expect(saved?.displayName).toBe(action === "rename" ? "手动标题" : undefined);
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(events.publish).not.toHaveBeenCalled();
		} finally { await service.close(); await backend.close(); }
	});

	it.each(["timeout", "shutdown"] as const)("bounds %s even when the provider ignores cancellation", async (action) => {
		const { backend, session, repository, model } = await setup();
		const pending = deferred();
		const completeSimple = vi.fn(() => pending.promise);
		const events = { publish: vi.fn() };
		const service = new SessionTitleService({ models: { completeSimple }, sessions: repository, events });
		try {
			vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
			service.start(session, model, "部署服务"); await Promise.resolve();
			if (action === "timeout") await vi.advanceTimersByTimeAsync(30_001);
			await service.close();
			pending.resolve(fauxAssistantMessage("迟到标题"));
			await Promise.resolve();
			expect((await repository.findById(session.id))?.displayName).toBe("新会话");
			expect(events.publish).not.toHaveBeenCalled();
		} finally { vi.useRealTimers(); await service.close(); await backend.close(); }
	});

	it.each(["", "标题\n解释", "a".repeat(121)])("keeps the placeholder for invalid title %j", async (title) => {
		const { backend, session, repository, model } = await setup();
		const events = { publish: vi.fn() };
		const service = new SessionTitleService({ models: { completeSimple: async () => fauxAssistantMessage(title) }, sessions: repository, events });
		try {
			service.start(session, model, "部署服务");
			await new Promise((resolve) => setImmediate(resolve));
			expect((await repository.findById(session.id))?.displayName).toBe("新会话");
			expect(events.publish).not.toHaveBeenCalled();
		} finally { await service.close(); await backend.close(); }
	});

	it("does not deliver Session events to other workspaces or existing transfer subscribers", async () => {
		const hub = new WorkspaceEventHub();
		const titleReader = hub.subscribe("a", new Set(["sessions"])).getReader();
		const otherReader = hub.subscribe("b", new Set(["sessions"])).getReader();
		const transferReader = hub.subscribe("a", new Set(["transfers"])).getReader();
		await Promise.all([titleReader.read(), otherReader.read(), transferReader.read()]);
		hub.publish("a", { type: "session.updated", data: { id: "s", workspaceId: "a", displayName: "标题", revision: 2, updatedAt: 1 } });
		hub.heartbeat();
		expect(new TextDecoder().decode((await titleReader.read()).value)).toContain("session.updated");
		expect(new TextDecoder().decode((await otherReader.read()).value)).toBe(": heartbeat\n\n");
		expect(new TextDecoder().decode((await transferReader.read()).value)).toBe(": heartbeat\n\n");
		await Promise.all([titleReader.cancel(), otherReader.cancel(), transferReader.cancel()]); hub.close();
	});
});
