import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ChatMessageProjection, ChatQueueItem } from "../src/domain/chat.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

async function fixture() {
	const localCwd = await mkdtemp(join(tmpdir(), "gori-stop-queue-"));
	const faux = fauxProvider({ provider: "stop-queue", models: [{ id: "model" }] });
	const backend = createSqliteManagementBackend({
		databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 28), localCwd,
		llmModelsFactory: (credentials) => { const models = createModels({ credentials }); models.setProvider(faux.provider); return models; },
	});
	const request = async (method: string, path: string, body?: unknown) => {
		const response = await backend.handleRequest(new Request(`http://localhost${path}`, {
			method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		}));
		expect(response.status).toBeLessThan(300);
		return response.status === 204 ? undefined : await response.json();
	};
	const workspace = await request("POST", "/api/workspaces", {
		displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
		credential: { displayName: "test", remoteUser: "test", type: "password", password: "test" }, defaultCwd: "/tmp",
	});
	const session = await request("POST", `/api/workspaces/${workspace.workspace.id}/sessions`, { displayName: "chat" });
	const root = `/api/sessions/${session.id}/chat`;
	return {
		backend, faux, root, request,
		start: () => request("POST", `${root}/runs`, {
			requestId: "initial", providerId: "stop-queue", modelId: "model", message: "initial", serverInteractionMode: "command",
		}),
		idle: () => waitFor(async () => (await request("GET", `${root}/runs/active`)).run === null),
		close: async () => { await backend.close(); await rm(localCwd, { recursive: true, force: true }); },
	};
}

function waitForAbort(options?: SimpleStreamOptions): Promise<void> {
	return new Promise((resolve) => {
		if (options?.signal?.aborted) resolve();
		else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
	});
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for queue continuation");
}

describe("stop output with queued messages", () => {
	it.each([
		{ waiting: "provider", behavior: "follow_up" },
		{ waiting: "approval", behavior: "follow_up" },
		{ waiting: "provider", behavior: "steer" },
		{ waiting: "approval", behavior: "steer" },
	])("consumes one $behavior at a time after stopping $waiting and keeps the rest pending", async ({ waiting, behavior }) => {
		const f = await fixture();
		let oldSignal: AbortSignal | undefined;
		const nextContexts: Context[] = [];
		let release = () => {};
		const firstReply = new Promise<void>((resolve) => { release = resolve; });
		const reply = (context: Context, options?: SimpleStreamOptions) => {
			expect(options?.signal?.aborted).toBe(false);
			expect(options?.signal).not.toBe(oldSignal);
			nextContexts.push({ ...context, messages: structuredClone(context.messages) });
			return fauxAssistantMessage(`queued message ${nextContexts.length} completed`);
		};
		f.faux.setResponses([
			waiting === "provider"
				? async (_context: Context, options?: SimpleStreamOptions) => { oldSignal = options?.signal; await waitForAbort(options); return fauxAssistantMessage("interrupted"); }
				: fauxAssistantMessage(fauxToolCall("write", { path: "cancelled.txt", content: "must not be written" }), { stopReason: "toolUse" }),
			async (context, options) => { const message = reply(context, options); await firstReply; return message; },
			reply,
			reply,
		]);
		try {
			const run = await f.start();
			if (waiting === "provider") await waitFor(() => oldSignal !== undefined);
			else await waitFor(async () => (await f.request("GET", `${f.root}/approvals?status=pending`)).approvals.length === 1);
			for (let index = 0; index < 3; index++) {
				await f.request("POST", `${f.root}/runs/${run.id}/queue`, { requestId: `queued-${index}`, behavior, message: `queued-${index}` });
			}
			const pending: ChatQueueItem[] = (await f.request("GET", `${f.root}/runs/${run.id}/queue`)).items;
			expect(await f.request("POST", `${f.root}/runs/${run.id}/cancel`)).toMatchObject({ id: run.id, status: "running" });
			await waitFor(() => nextContexts.length === 1);
			expect((await f.request("GET", `${f.root}/runs/${run.id}/queue`)).items.map((item: ChatQueueItem) => item.id))
				.toEqual(pending.slice(1).map((item) => item.id));
			expect((await f.request("GET", `${f.root}/runs/${run.id}/queue?status=consumed`)).items.map((item: ChatQueueItem) => item.id))
				.toEqual([pending[0]!.id]);
			release();
			await f.idle();
			expect(f.faux.state.callCount).toBe(4);
			expect(f.backend.database.prepare("SELECT status, failure_json FROM chat_runs WHERE id = ?").get(run.id))
				.toMatchObject({ status: "completed", failure_json: null });
			const messages: ChatMessageProjection[] = (await f.request("GET", `${f.root}/messages`)).messages;
			expect(messages.filter((item) => item.message.role === "user").map((item) => item.message))
				.toEqual([expect.objectContaining({ role: "user" }), ...pending.map((item) => item.message)]);
			expect(messages.filter((message) => message.message.role === "user" || message.message.role === "assistant")
				.every((message) => message.runId === run.id)).toBe(true);
			expect(nextContexts.map((context) => context.messages.filter((message) => message.role === "user").length)).toEqual([2, 3, 4]);
			expect((await f.request("GET", `${f.root}/runs/${run.id}/queue?status=consumed`)).items.map((item: ChatQueueItem) => item.id))
				.toEqual(pending.map((item) => item.id));
			expect((await f.request("GET", `${f.root}/runs/${run.id}/queue?status=cancelled`)).items).toEqual([]);
		} finally { release(); await f.close(); }
	});

	it("rechecks the queue after stopping so removed messages stay removed", async () => {
		const f = await fixture();
		let release = () => {};
		const settled = new Promise<void>((resolve) => { release = resolve; });
		f.faux.setResponses([
			async (_context, options) => { await waitForAbort(options); await settled; return fauxAssistantMessage("interrupted"); },
			fauxAssistantMessage("remaining message completed"),
		]);
		try {
			const run = await f.start();
			await waitFor(() => f.faux.state.callCount === 1);
			const removed = await f.request("POST", `${f.root}/runs/${run.id}/queue`, { requestId: "removed", behavior: "follow_up", message: "removed" });
			await f.request("POST", `${f.root}/runs/${run.id}/queue`, { requestId: "keep", behavior: "follow_up", message: "keep" });
			await f.request("POST", `${f.root}/runs/${run.id}/cancel`);
			await f.request("DELETE", `${f.root}/runs/${run.id}/queue/${removed.id}`);
			release();
			await f.idle();
			const messages: ChatMessageProjection[] = (await f.request("GET", `${f.root}/messages`)).messages;
			expect(JSON.stringify(messages)).not.toContain('"text":"removed"');
			expect((await f.request("GET", `${f.root}/runs/${run.id}/queue?status=consumed`)).items).toMatchObject([{ requestId: "keep" }]);
			expect(f.faux.state.callCount).toBe(2);
		} finally { release(); await f.close(); }
	});

	it("allows another stop after continuation, and cancels when the queue is empty", async () => {
		const f = await fixture();
		const signals: AbortSignal[] = [];
		const interrupted = async (_context: Context, options?: SimpleStreamOptions) => {
			signals.push(options!.signal!);
			await waitForAbort(options);
			return fauxAssistantMessage("interrupted");
		};
		f.faux.setResponses([interrupted, interrupted, interrupted, fauxAssistantMessage("must not execute")]);
		try {
			const run = await f.start();
			await waitFor(() => signals.length === 1);
			for (let index = 0; index < 2; index++) {
				await f.request("POST", `${f.root}/runs/${run.id}/queue`, { requestId: `next-${index}`, behavior: "follow_up", message: `next-${index}` });
			}
			await f.request("POST", `${f.root}/runs/${run.id}/cancel`);
			await waitFor(() => signals.length === 2);
			expect(signals[1]!.aborted).toBe(false);
			expect((await f.request("GET", `${f.root}/runs/${run.id}/queue`)).items).toHaveLength(1);
			await f.request("POST", `${f.root}/runs/${run.id}/cancel`);
			await waitFor(() => signals.length === 3);
			expect(signals[2]!.aborted).toBe(false);
			expect((await f.request("GET", `${f.root}/runs/${run.id}/queue`)).items).toEqual([]);
			await f.request("POST", `${f.root}/runs/${run.id}/cancel`);
			await f.idle();
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(f.faux.state.callCount).toBe(3);
			expect(f.backend.database.prepare("SELECT status, failure_json FROM chat_runs WHERE id = ?").get(run.id))
				.toMatchObject({ status: "cancelled", failure_json: null });
		} finally { await f.close(); }
	});
});
