import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import type { DiagnoseTask } from "../src/domain/diagnose.ts";
import type { ChatRun } from "../src/domain/chat.ts";

describe("diagnosis with the existing Chat harness", () => {
	it("queues one conclusion, cancels it if the model already finished, and exits without a model call", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "gori-diagnose-queue-"));
		const faux = fauxProvider({ provider: "diagnose-queue-faux", models: [{ id: "model", contextWindow: 128000, maxTokens: 8192 }] });
		faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "test-only.txt", content: "test" }), { stopReason: "toolUse" })]);
		const backend = createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 8), localCwd,
			llmModelsFactory: (credentials) => { const models = createModels({ credentials }); models.setProvider(faux.provider); return models; } });
		const post = async (path: string, body: unknown = {}) => backend.handleRequest(new Request(`http://localhost/api/sessions/s/${path}`, {
			method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
		try {
			backend.database.exec(`INSERT INTO workspaces (id,display_name,environment,hostname,port,default_cwd,connect_timeout_ms,keepalive_interval_ms,keepalive_max_count,revision,created_at,updated_at)
				VALUES ('w','test','development','localhost',22,'/tmp',1000,1000,3,1,1,1);
				INSERT INTO workspace_host_trusts VALUES ('w','ssh-ed25519','SHA256:fake',1);
				INSERT INTO credentials (id,workspace_id,display_name,type,remote_user,is_active,auth_version,revision,created_at,updated_at)
				VALUES ('c','w','test','password','test',1,1,1,1,1);
				INSERT INTO sessions (id,workspace_id,display_name,revision,created_at,updated_at) VALUES ('s','w','test',1,1,1);`);
			const started = await (await post("diagnoses", { requestId: "start", providerId: "diagnose-queue-faux", modelId: "model" })).json() as { task: DiagnoseTask; run: ChatRun };
			const repository = new SqliteChatRepository(backend.database);
			await vi.waitFor(() => expect(repository.listApprovals("s", "pending")).toHaveLength(1));
			const url = `diagnoses/${started.task.id}/conclusion-requests`;
			const [first, duplicate] = await Promise.all([post(url, { requestId: "finish-1" }), post(url, { requestId: "finish-2" })]);
			const a = await first.json() as { queueItemId: string }; const b = await duplicate.json() as { queueItemId: string };
			expect(a.queueItemId).toBe(b.queueItemId); expect(repository.listQueue("s", started.run.id, "pending")).toHaveLength(1);
			await backend.diagnoses.finish({ sessionId: "s", taskId: started.task.id, runId: started.run.id, toolCallId: "finish-now" }, "# Already sufficient\n\nNo cause established.");
			expect(repository.listQueue("s", started.run.id, "pending")).toEqual([]);
			expect(faux.state.callCount).toBe(1);
			await post("chat/runs/" + started.run.id + "/cancel");
			await vi.waitFor(() => expect(repository.findRun(started.run.id, "s")?.status).toBe("cancelled"));
			const next = await backend.diagnoses.create("s", "next");
			const ended = await post(`diagnoses/${next.id}/cancel`);
			expect(await ended.json()).toMatchObject({ status: "cancelled", conclusionAvailable: false });
			expect(faux.state.callCount).toBe(1);
			expect(backend.database.prepare("SELECT count(*) AS n FROM diagnose_nodes WHERE task_id=?").get(next.id)?.n).toBe(0);
		} finally { await backend.close(); await rm(localCwd, { recursive: true, force: true }); }
	});
	it("records checkpoints without approval, persists across Runs, and saves a separate Markdown conclusion", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "gori-diagnose-"));
		const faux = fauxProvider({ provider: "diagnose-faux", models: [{ id: "model", contextWindow: 128000, maxTokens: 8192 }] });
		const prompts: string[] = [];
		const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
		faux.setResponses([
			tool("diagnose_update", { title: "Intermittent 502", node: { action: "append", direction: "Inspect proxy logs" } }),
			fauxAssistantMessage("Please provide the incident time."),
			tool("diagnose_update", { node: { action: "update_current", status: "unconfirmed", explanation: "No correlated logs are available; root cause remains uncertain." } }),
			fauxAssistantMessage("The current evidence is inconclusive."),
			tool("diagnose_finish", { conclusionMarkdown: "# Conclusion\n\nThe root cause is **unconfirmed**.\n\n| Fact | Result |\n|---|---|\n| Proxy logs | Unavailable |" }),
			fauxAssistantMessage("Conclusion saved."),
		].map((response) => (context: Context) => { prompts.push(context.systemPrompt ?? ""); return response; }));
		const backend = createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 8), localCwd,
			llmModelsFactory: (credentials) => { const models = createModels({ credentials }); models.setProvider(faux.provider); return models; } });
		const request = async (method: string, path: string, body?: unknown) => backend.handleRequest(new Request(`http://localhost${path}`, { method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
		try {
			const workspace = await (await request("POST", "/api/workspaces", { displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
				credential: { displayName: "test", remoteUser: "test", type: "password", password: "fake-only" }, defaultCwd: localCwd })).json() as { workspace: { id: string } };
			const session = await (await request("POST", `/api/workspaces/${workspace.workspace.id}/sessions`, { displayName: "diagnosis" })).json() as { id: string };
			const root = `/api/sessions/${session.id}`;
			const startedResponse = await request("POST", `${root}/diagnoses`, { requestId: "first", problem: "Investigate 502 responses", providerId: "diagnose-faux", modelId: "model" });
			expect(startedResponse.status).toBe(201);
			const started = await startedResponse.json() as { task: DiagnoseTask; run: ChatRun };
			const repository = new SqliteChatRepository(backend.database);
			await vi.waitFor(() => expect(repository.findRun(started.run.id, session.id)?.status).toBe("completed"));
			expect(backend.diagnoses.active(session.id)?.id).toBe(started.task.id);
			expect(repository.listApprovals(session.id, "pending")).toEqual([]);
			expect(repository.listApprovals(session.id, "approved")).toEqual([]);
			const blockedDeploy = await request("POST", `${root}/deployments`, { file: "deploy-missing.md", moduleId: "api" });
			expect(blockedDeploy.status).toBe(409);
			expect(await blockedDeploy.json()).toMatchObject({ error: { code: "session_task_mode_conflict" } });
			const blockedSetup = await request("POST", `${root}/chat/runs`, { requestId: "setup", message: "Set up deployment", workflow: "deployment_setup", serverInteractionMode: "command" });
			expect(blockedSetup.status).toBe(409);
			const repeated = await (await request("POST", `${root}/diagnoses`, { requestId: "reveal" })).json() as { task: DiagnoseTask; run?: ChatRun };
			expect(repeated.task.id).toBe(started.task.id); expect(repeated.run).toBeUndefined();
			const followup = await (await request("POST", `${root}/chat/runs`, { requestId: "followup", message: "Logs are unavailable", serverInteractionMode: "command" })).json() as ChatRun;
			await vi.waitFor(() => expect(repository.findRun(followup.id, session.id)?.status).toBe("completed"));
			expect(backend.diagnoses.active(session.id)).not.toBeNull();
			const conclusion = await request("POST", `${root}/diagnoses/${started.task.id}/conclusion-requests`, { requestId: "conclude" });
			expect(conclusion.status).toBe(200);
			const summarizing = await conclusion.json() as { run: ChatRun };
			await vi.waitFor(() => expect(repository.findRun(summarizing.run.id, session.id)?.status).toBe("completed"));
			const final = await (await request("GET", `${root}/diagnoses/${started.task.id}`)).json() as DiagnoseTask;
			expect(final).toMatchObject({ status: "completed", conclusionAvailable: true });
			expect(JSON.stringify(final)).not.toContain("# Conclusion");
			expect(await (await request("GET", `${root}/diagnoses/${started.task.id}/conclusion`)).json()).toMatchObject({ markdown: expect.stringContaining("# Conclusion") });
			const retry = await (await request("POST", `${root}/diagnoses/${started.task.id}/conclusion-requests`, { requestId: "conclude" })).json() as { task: DiagnoseTask };
			expect(retry.task.status).toBe("completed"); expect(faux.state.callCount).toBe(6);
			const skill = readFileSync(new URL("../resources/skills/gori-diagnosis/SKILL.md", import.meta.url), "utf8").trim();
			expect(prompts).toHaveLength(6);
			for (const prompt of prompts.slice(0, 5)) {
				expect(prompt).toContain(`<diagnose-skill>\n${skill}\n</diagnose-skill>`);
				expect(prompt.match(/<diagnose-skill>/gu)).toHaveLength(1);
			}
			expect(prompts[5]).not.toContain("<diagnose-skill>");
			expect(backend.database.prepare("SELECT system_prompt FROM chat_prompt_snapshots WHERE session_id=?").get(session.id)?.system_prompt).not.toContain("<diagnose-skill>");
			const messages = repository.listMessages(session.id);
			expect(messages.filter((entry) => entry.message.role === "custom" && entry.message.customType === "diagnose")).toHaveLength(1);
			expect(repository.listApprovals(session.id, "pending")).toEqual([]);
			expect((await request("POST", `${root}/diagnoses`, { requestId: "invalid", surprise: true })).status).toBe(400);
		} finally { await backend.close(); await rm(localCwd, { recursive: true, force: true }); }
	});
});
