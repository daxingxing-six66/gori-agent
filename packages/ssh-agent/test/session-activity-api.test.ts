import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ChatRun } from "../src/domain/chat.ts";
import type { SessionActivityEvent } from "../src/domain/session-activity.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

async function fixture() {
	const localCwd = await mkdtemp(join(tmpdir(), "gori-session-activity-"));
	const faux = fauxProvider({ provider: "activity-faux", models: [{ id: "model" }] });
	const backend = createSqliteManagementBackend({
		databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 29), localCwd,
		llmModelsFactory: (credentials) => { const models = createModels({ credentials }); models.setProvider(faux.provider); return models; },
	});
	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await backend.handleRequest(new Request(`http://localhost${path}`, {
			method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		}));
		expect(response.status).toBeLessThan(300);
		return await response.json() as T;
	}
	const { workspace } = await request<{ workspace: { id: string } }>("POST", "/api/workspaces", {
		displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
		credential: { displayName: "test", remoteUser: "test", type: "password", password: "test" }, defaultCwd: localCwd,
	});
	const session = await request<{ id: string }>("POST", `/api/workspaces/${workspace.id}/sessions`, { displayName: "activity" });
	const root = `/api/sessions/${session.id}/chat`;
	return {
		backend, faux, request, root, sessionId: session.id, workspaceId: workspace.id,
		start: () => request<ChatRun>("POST", `${root}/runs`, { requestId: "initial", providerId: "activity-faux", modelId: "model", message: "Work", serverInteractionMode: "command" }),
		stream: async (signal?: AbortSignal) => {
			const response = await backend.handleRequest(new Request("http://localhost/api/session-activity/events", { signal }));
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
			return response.body!.getReader();
		},
		close: async () => { await backend.close(); await rm(localCwd, { recursive: true, force: true }); },
	};
}

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SessionActivityEvent> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for activity")), 2000); })]);
		expect(chunk.done).toBe(false);
		const text = new TextDecoder().decode(chunk.value);
		const type = /^event: (.+)$/m.exec(text)![1];
		return { type, data: JSON.parse(/^data: (.+)$/m.exec(text)![1]!) } as SessionActivityEvent;
	} finally { clearTimeout(timer); }
}

async function until(reader: ReadableStreamDefaultReader<Uint8Array>, match: (event: SessionActivityEvent) => boolean): Promise<SessionActivityEvent[]> {
	const events: SessionActivityEvent[] = [];
	for (let i = 0; i < 20; i++) { const event = await frame(reader); events.push(event); if (match(event)) return events; }
	throw new Error("Expected activity event was not delivered");
}

describe("global session activity HTTP stream", () => {
	it("leaves five historical sessions unmarked and publishes only the target Run's lifecycle", async () => {
		const f = await fixture();
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		f.faux.setResponses([async () => { await gate; return fauxAssistantMessage("Done"); }]);
		try {
			const ids = [f.sessionId];
			for (let i = 1; i < 5; i++) {
				const session = await f.request<{ id: string }>("POST", `/api/workspaces/${f.workspaceId}/sessions`, { displayName: `history ${i}` });
				ids.push(session.id);
			}
			for (const [i, id] of ids.entries()) {
				f.backend.database.prepare(`INSERT INTO chat_runs (id, session_id, workspace_id, request_id,
					provider_id, model_id, thinking_level, status, created_at, updated_at)
					VALUES (?, ?, ?, ?, 'activity-faux', 'model', 'off', 'completed', 1, 2)`)
					.run(`historical-${i}`, id, f.workspaceId, `historical-${i}`);
			}
			const reader = await f.stream();
			try {
				expect(await frame(reader)).toEqual({ type: "activity.snapshot", data: { activities: [] } });
				const run = await f.start();
				const running = await until(reader, (event) => event.type === "activity.updated" && event.data.activity?.state === "running");
				release();
				const completed = await until(reader, (event) => event.type === "activity.updated" && event.data.activity?.state === "completed");
				expect([...running, ...completed].every((event) => event.type === "activity.updated" && event.data.sessionId === f.sessionId && event.data.runId === run.id)).toBe(true);
				const reconnect = await f.stream();
				try {
					expect(await frame(reconnect)).toEqual({ type: "activity.snapshot", data: { activities: [{ sessionId: f.sessionId, workspaceId: f.workspaceId, runId: run.id, state: "completed" }] } });
				} finally { await reconnect.cancel(); }
			} finally { await reader.cancel(); }
		} finally { release(); await f.close(); }
	});

	it.each(["approval", "decision"] as const)("recovers %s waits and keeps the same Run active while a queued message continues", async (waiting) => {
		const f = await fixture();
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let continued = false;
		const call = waiting === "approval" ? fauxToolCall("write", { path: "not-written.txt", content: "private" })
			: fauxToolCall("ask_user_decision", { questions: [{ question: "Pick one", options: [{ label: "A", description: "A" }, { label: "B", description: "B" }], recommendedIndex: 0 }] });
		f.faux.setResponses([
			fauxAssistantMessage(call, { stopReason: "toolUse" }),
			async () => { continued = true; await gate; return fauxAssistantMessage("Queue completed"); },
		]);
		const reader = await f.stream();
		try {
			expect(await frame(reader)).toEqual({ type: "activity.snapshot", data: { activities: [] } });
			const run = await f.start();
			const waitingState = waiting === "approval" ? "waiting_approval" : "waiting_input";
			await until(reader, (event) => event.type === "activity.updated" && event.data.activity?.state === waitingState);
			const reconnect = await f.stream();
			expect(await frame(reconnect)).toEqual({ type: "activity.snapshot", data: { activities: [{ sessionId: f.sessionId, workspaceId: run.workspaceId, runId: run.id, state: waitingState }] } });
			await reconnect.cancel();
			await f.request("POST", `${f.root}/runs/${run.id}/queue`, { requestId: "next", behavior: "follow_up", message: "Continue" });
			expect(await f.request("POST", `${f.root}/runs/${run.id}/cancel`)).toMatchObject({ id: run.id, status: "running" });
			const transition = await until(reader, (event) => event.type === "activity.updated" && event.data.activity?.state === "running");
			expect(transition.every((event) => event.type !== "activity.updated" || event.data.activity !== null)).toBe(true);
			for (let i = 0; i < 100 && !continued; i++) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(continued).toBe(true);
			const current = await f.stream();
			expect(await frame(current)).toMatchObject({ type: "activity.snapshot", data: { activities: [{ runId: run.id, state: "running" }] } });
			await current.cancel();
			release();
			await until(reader, (event) => event.type === "activity.updated" && event.data.activity?.state === "completed");
			expect(f.backend.database.prepare("SELECT status FROM chat_runs WHERE id = ?").get(run.id)).toMatchObject({ status: "completed" });
			const finished = await f.stream();
			expect(await frame(finished)).toMatchObject({ type: "activity.snapshot", data: { activities: [{ sessionId: f.sessionId, runId: run.id, state: "completed" }] } });
			await finished.cancel();
		} finally { release(); await reader.cancel(); await f.close(); }
	});

	it("closes a cancelled HTTP subscription without cancelling Agent work", async () => {
		const f = await fixture();
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		f.faux.setResponses([async () => { await gate; return fauxAssistantMessage("Finished"); }]);
		try {
			const run = await f.start();
			const abort = new AbortController();
			const reader = await f.stream(abort.signal);
			expect(await frame(reader)).toMatchObject({ data: { activities: [{ runId: run.id, state: "running" }] } });
			abort.abort();
			expect((await reader.read()).done).toBe(true);
			const next = await f.stream();
			expect(await frame(next)).toMatchObject({ data: { activities: [{ runId: run.id, state: "running" }] } });
			expect(await f.request("GET", `${f.root}/runs/active`)).toMatchObject({ run: { id: run.id, status: "running" } });
			await next.cancel();
		} finally { release(); await f.close(); }
	});
});
