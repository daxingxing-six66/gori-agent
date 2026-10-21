import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

describe("Chat document attachments through the local read tool", () => {
	it("sends a file reference to a text model and reads its contents only after a tool call", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gori-document-read-"));
		const workDir = join(directory, "workspace");
		const dataDir = join(directory, "data");
		await mkdir(workDir);
		const contexts: Context[] = [];
		const documentText = "# Uploaded specification\n\nUNIQUE_DOCUMENT_BODY_8a23\n";
		const faux = fauxProvider({ provider: "document-reader-faux", models: [
			{ id: "text", input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
		] });
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 37),
			localCwd: workDir, attachmentBaseDir: dataDir,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		const request = async (method: string, path: string, body?: unknown) => {
			const response = await backend.handleRequest(new Request(`http://localhost${path}`, {
				method, headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}));
			return { status: response.status, body: await response.json() as unknown };
		};
		try {
			const workspace = await request("POST", "/api/workspaces", {
				displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
				credential: { displayName: "test", remoteUser: "test", type: "password", password: "test" }, defaultCwd: "/tmp",
			});
			const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
			const session = await request("POST", `/api/workspaces/${workspaceId}/sessions`, { displayName: "documents" });
			const sessionId = (session.body as { id: string }).id;
			const uploaded = await backend.handleRequest(new Request(`http://localhost/api/sessions/${sessionId}/attachments?name=specification.md`, {
				method: "POST", headers: { "content-type": "application/octet-stream" }, body: documentText,
			}));
			expect(uploaded.status).toBe(201);
			const attachment = await uploaded.json() as { id: string; name: string; storagePath: string };
			const localPath = join(dataDir, ...attachment.storagePath.split("/"));
			const preview = await request("GET", `/api/sessions/${sessionId}/attachments/${attachment.id}/text`);
			expect(preview).toMatchObject({ status: 200, body: { path: attachment.name, name: attachment.name, content: documentText } });
			expect(JSON.stringify(preview.body)).not.toContain(directory);

			faux.setResponses([
				(context) => {
					contexts.push(context);
					return fauxAssistantMessage(fauxToolCall("read", { path: localPath }, { id: "read-uploaded-document" }), { stopReason: "toolUse" });
				},
				(context) => { contexts.push(context); return fauxAssistantMessage("Document checked."); },
			]);
			const created = await request("POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "read-document", providerId: "document-reader-faux", modelId: "text", message: "Check the attached specification",
				attachmentIds: [attachment.id], serverInteractionMode: "command",
			});
			expect(created.status).toBe(201);
			await waitFor(async () => ((await request("GET", `/api/sessions/${sessionId}/chat/runs/active`)).body as { run: unknown }).run === null);
			expect(contexts).toHaveLength(2);
			const initialUser = contexts[0]!.messages.find((message) => message.role === "user");
			expect(JSON.stringify(initialUser)).toContain("Check the attached specification");
			expect(JSON.stringify(initialUser)).toContain(attachment.name);
			expect(JSON.stringify(initialUser)).toContain(JSON.stringify(localPath).slice(1, -1));
			expect(JSON.stringify(initialUser)).toContain("read");
			expect(JSON.stringify(contexts[0])).not.toContain("UNIQUE_DOCUMENT_BODY_8a23");
			expect(contexts[1]!.messages.find((message) => message.role === "toolResult")).toMatchObject({
				role: "toolResult", toolCallId: "read-uploaded-document", isError: false,
				content: [{ type: "text", text: documentText }],
			});
			const history = await request("GET", `/api/sessions/${sessionId}/chat/messages`);
			const entries = (history.body as { messages: Array<{ message: { role: string } }> }).messages;
			expect(entries.find((entry) => entry.message.role === "user")).toMatchObject({
				message: { content: "Check the attached specification", attachmentIds: [attachment.id] },
				attachments: [{ id: attachment.id, name: attachment.name }],
			});
			expect(backend.database.prepare("SELECT COUNT(*) AS count FROM chat_tool_approvals").get()).toEqual({ count: 0 });
		} finally {
			await backend.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the local document Run");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
