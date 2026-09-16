import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { ChatMessageProjection, ChatQueueItem, ChatRun, ToolApproval } from "../src/domain/chat.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

it("delivers the promoted item once before the remaining follow-up through the real Agent", async () => {
	const localCwd = await mkdtemp(join(tmpdir(), "ssh-queue-promote-"));
	const faux = fauxProvider({ provider: "queue-promotion", models: [{ id: "model" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "test" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("steering handled"),
		fauxAssistantMessage("follow-up handled"),
	]);
	const backend = createSqliteManagementBackend({
		databasePath: ":memory:",
		localCwd,
		credentialEncryptionKey: Buffer.alloc(32, 4),
		llmModelsFactory: (credentials) => {
			const models = createModels({ credentials });
			models.setProvider(faux.provider);
			return models;
		},
	});
	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await backend.handleRequest(
			new Request(`http://localhost${path}`, {
				method,
				...(body === undefined
					? {}
					: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			}),
		);
		expect(response.ok).toBe(true);
		return response.json() as Promise<T>;
	}
	try {
		const { workspace } = await request<{ workspace: { id: string } }>("POST", "/api/workspaces", {
			displayName: "test",
			environment: "development",
			host: { hostname: "localhost", port: 22 },
			credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
			defaultCwd: "/tmp",
		});
		const session = await request<{ id: string }>("POST", `/api/workspaces/${workspace.id}/sessions`, {
			displayName: "test",
		});
		const root = `/api/sessions/${session.id}/chat`;
		const run = await request<ChatRun>("POST", `${root}/runs`, {
			requestId: "run",
			providerId: "queue-promotion",
			modelId: "model",
			message: "write a note",
			serverInteractionMode: "command",
		});
		let approvalId = "";
		await waitFor(async () => {
			const { approvals } = await request<{ approvals: ToolApproval[] }>("GET", `${root}/approvals`);
			approvalId = approvals[0]?.id ?? "";
			return approvalId !== "";
		});
		const queuePath = `${root}/runs/${run.id}/queue`;
		await request("POST", queuePath, { requestId: "later", behavior: "follow_up", message: "later follow-up" });
		const item = await request<{ id: string }>("POST", queuePath, {
			requestId: "now",
			behavior: "follow_up",
			message: "steer now",
		});
		await request("POST", `${queuePath}/${item.id}/steer`);
		await request("POST", `${queuePath}/${item.id}/steer`);
		await request("POST", `${root}/approvals/${approvalId}/approve`);
		await waitFor(async () => (await request<{ run: ChatRun | null }>("GET", `${root}/runs/active`)).run === null);
		const { messages } = await request<{ messages: ChatMessageProjection[] }>("GET", `${root}/messages`);
		expect(messages.flatMap(({ message }) => (message.role === "user" ? [message.content] : []))).toEqual([
			"write a note",
			"steer now",
			"later follow-up",
		]);
		const { items } = await request<{ items: ChatQueueItem[] }>("GET", `${queuePath}?status=consumed`);
		expect(items).toHaveLength(2);
		expect(items.find((entry) => entry.id === item.id)).toMatchObject({
			behavior: "steer",
			status: "consumed",
			requestId: "now",
		});
	} finally {
		await backend.close();
		await rm(localCwd, { recursive: true, force: true });
	}
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for Agent");
}
