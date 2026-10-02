import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { ChatRunRuntime } from "../src/application/chat-run-runtime.ts";
import { ChatPromptService } from "../src/application/services/chat-prompt-service.ts";
import { SqliteChatPromptRepository } from "../src/infrastructure/sqlite/sqlite-chat-prompt-repository.ts";
import { SqliteWorkspaceRepository } from "../src/infrastructure/sqlite/sqlite-workspace-repository.ts";
import { ChatAttachmentService } from "../src/application/services/chat-attachment-service.ts";
import { createChatService } from "../src/application/services/create-chat-service.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import { SqliteAttachmentRepository } from "../src/infrastructure/sqlite/sqlite-attachment-repository.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import type { AgentDeploymentService } from "../src/application/tools/deployment-agent-tool.ts";
import type { DeploymentRun } from "../src/domain/deployment.ts";

function namedTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	};
}

describe("ChatService Run lifecycle", () => {
	it("retries deployment settlement before committing a Chat Run terminal status, including setup failure", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "gori-deploy-chat-"));
		const faux = fauxProvider({ provider: "deploy-chat-provider", models: [{ id: "model", contextWindow: 128_000, maxTokens: 8_192 }] });
		faux.setResponses([fauxAssistantMessage("The deployment is done")]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:", credentialEncryptionKey: Buffer.alloc(32, 21), localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		const plan: DeploymentRun = {
			id: "deploy-1", sessionId: "session-1", workspaceId: "workspace-1", status: "preparing",
			plan: {
				profilePath: "/project/.gori/deploy-host.md", profileHash: "hash", remoteAccess: { mode: "workspace_write" },
				project: "project", target: { host: "localhost" },
				targetBinding: { port: 22, hostKeyFingerprint: "fingerprint", credentialId: "credential-1", credentialAuthVersion: 1, remoteUser: "root", writableRoot: "/tmp" },
				module: { id: "api", name: "API" }, build: { cwd: "/project", command: "make build", artifact: "/project/api.tar" },
				upload: { remotePath: "/tmp/api.tar" }, restart: { command: "systemctl restart api" },
			},
			stages: {
				prepare: { status: "success", log: "" }, build: { status: "pending", log: "" },
				upload: { status: "pending", log: "" }, restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" },
			},
			createdAt: 1, updatedAt: 1,
		};
		const callOrder: string[] = [];
		let failedSettlements = 2;
		let closeAfterClaim = false;
		let closeTask: Promise<void> | undefined;
		let currentRunId = "agent-1";
		let chat!: ReturnType<typeof createChatService>;
		const deployments: AgentDeploymentService = {
			get: vi.fn(() => plan),
			claimForAgent: vi.fn(async () => {
				callOrder.push("claim");
				if (closeAfterClaim) closeTask = chat.close();
				return plan;
			}),
			executeStageForAgent: vi.fn(async () => plan),
			finishAgent: vi.fn(async () => {
				callOrder.push("finish");
				if (failedSettlements-- > 0) throw new Error("injected SQLite settlement failure");
			}),
		};
		let systemPrompt = "";
		chat = createChatService({
			prompts: new ChatPromptService(new SqliteChatPromptRepository(backend.database), new SqliteWorkspaceRepository(backend.database)),
			chatRepository: new SqliteChatRepository(backend.database),
			chatAttachments: new ChatAttachmentService({ attachments: new SqliteAttachmentRepository(backend.database), attachmentBaseDir: localCwd }),
			sessions: new SqliteSessionRepository(backend.database),
			models: backend.llmModels, catalog: backend.llmModelCatalog, localCwd,
			ids: { next: () => currentRunId }, deployments,
			createRemoteTool: () => namedTool("remote_server_call"), createTerminalTool: () => namedTool("terminal_interaction"),
			bindServerInteraction: async () => null, unbindTerminalRun: async () => undefined,
			terminalInteractions: backend.terminalInteractions,
			createSftpTool: () => namedTool("sftp_upload"), createSftpDownloadTool: () => namedTool("sftp_download"),
			preflightRemoteGuard: async () => ({ allowed: true }),
			runtimeFactory: {
				create: async ({ run, model, workDir, history, systemPrompt: prompt, deploymentRunId }) => {
					callOrder.push("runtime");
					systemPrompt = prompt;
					expect(deploymentRunId).toBe("deploy-1");
					const env = new NodeExecutionEnv({ cwd: workDir });
					const agent = new Agent({
						initialState: { model, messages: history },
						streamFn: (selectedModel, context, options) => backend.llmModels.streamSimple(selectedModel, context, options),
					});
					const runtime = new ChatRunRuntime({ run, agent, env });
					const dispose = runtime.dispose.bind(runtime);
					vi.spyOn(runtime, "dispose").mockImplementation(async () => {
						await dispose();
						callOrder.push("dispose");
					});
					return runtime;
				},
			},
		});
		try {
			const workspace = await requestJson(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" }, defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace as { workspace: { id: string } }).workspace.id);
			const session = await requestJson(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, { displayName: "chat" });
			const sessionId = String((session as { id: string }).id);
			const run = await chat.createRun({
				sessionId, requestId: "request-1", providerId: "deploy-chat-provider", modelId: "model",
				message: "Run the confirmed plan", serverInteractionMode: "command", workflow: "deployment_execution", deploymentRunId: "deploy-1",
			});
			await waitFor(async () => callOrder.includes("dispose"));
			const repository = new SqliteChatRepository(backend.database);
			expect(repository.findRun(run.id, sessionId)?.status).toBe("running");
			expect(callOrder).toEqual(["runtime", "claim", "finish", "dispose"]);
			await expect(chat.hasActiveRun(sessionId)).rejects.toMatchObject({ code: "chat_persistence_failed" });
			expect(repository.findRun(run.id, sessionId)?.status).toBe("running");
			expect(await chat.hasActiveRun(sessionId)).toBe(false);
			expect(repository.findRun(run.id, sessionId)?.status).toBe("completed");
			expect(callOrder).toEqual(["runtime", "claim", "finish", "dispose", "finish", "finish"]);
			expect(systemPrompt).toContain("deployment_execute_next");
			expect(systemPrompt).toContain("make build");
			expect(deployments.claimForAgent).toHaveBeenCalledWith(sessionId, "deploy-1", "agent-1");
			expect(deployments.finishAgent).toHaveBeenCalledWith(sessionId, "deploy-1", "agent-1", "completed");

			currentRunId = "agent-2";
			failedSettlements = 2;
			closeAfterClaim = true;
			await expect(chat.createRun({
				sessionId, requestId: "request-2", providerId: "deploy-chat-provider", modelId: "model",
				message: "Run the confirmed plan", serverInteractionMode: "command", workflow: "deployment_execution", deploymentRunId: "deploy-1",
			})).rejects.toMatchObject({ code: "chat_persistence_failed" });
			await closeTask;
			expect(repository.findRun("agent-2", sessionId)?.status).toBe("pending");
			await expect(chat.hasActiveRun(sessionId)).rejects.toMatchObject({ code: "chat_persistence_failed" });
			expect(repository.findRun("agent-2", sessionId)?.status).toBe("pending");
			expect(await chat.hasActiveRun(sessionId)).toBe(false);
			expect(repository.findRun("agent-2", sessionId)?.status).toBe("failed");
			expect(deployments.finishAgent).toHaveBeenCalledWith(sessionId, "deploy-1", "agent-2", "failed");
		} finally {
			await chat.close();
			await backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});

	it("releases active state and the Session lease when Runtime cleanup and Terminal unbind fail", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-lifecycle-"));
		const faux = fauxProvider({
			provider: "chat-lifecycle-provider",
			models: [{ id: "chat-lifecycle-model", contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([fauxAssistantMessage("completed")]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 19),
			localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		const lifecycle = new SessionLifecycleCoordinator();
		let failUnbind = false;
		const unbindTerminalRun = vi.fn(async () => {
			if (failUnbind) throw new Error("Terminal unbind failed");
		});
		let cleanup: ReturnType<typeof vi.spyOn> | undefined;
		let nextId = 0;
		const chat = createChatService({
			prompts: new ChatPromptService(
				new SqliteChatPromptRepository(backend.database),
				new SqliteWorkspaceRepository(backend.database),
			),
			chatRepository: new SqliteChatRepository(backend.database),
			chatAttachments: new ChatAttachmentService({
				attachments: new SqliteAttachmentRepository(backend.database),
				attachmentBaseDir: localCwd,
			}),
			sessions: new SqliteSessionRepository(backend.database),
			models: backend.llmModels,
			catalog: backend.llmModelCatalog,
			localCwd,
			ids: { next: () => `lifecycle-${++nextId}` },
			lifecycle,
			createRemoteTool: () => namedTool("remote_server_call"),
			createTerminalTool: () => namedTool("terminal_interaction"),
			bindServerInteraction: async () => "terminal-1",
			unbindTerminalRun,
			terminalInteractions: backend.terminalInteractions,
			createSftpTool: () => namedTool("sftp_upload"),
			createSftpDownloadTool: () => namedTool("sftp_download"),
			preflightRemoteGuard: async () => ({ allowed: true }),
			runtimeFactory: {
				create: async ({ run, model, workDir, history }) => {
					const env = new NodeExecutionEnv({ cwd: workDir });
					cleanup = vi.spyOn(env, "cleanup").mockRejectedValue(new Error("Execution cleanup failed"));
					const agent = new Agent({
						initialState: { model, messages: history },
						streamFn: (selectedModel, context, options) =>
							backend.llmModels.streamSimple(selectedModel, context, options),
					});
					return new ChatRunRuntime({ run, agent, env });
				},
			},
		});
		try {
			const workspace = await requestJson(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace as { workspace: { id: string } }).workspace.id);
			const session = await requestJson(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "chat",
			});
			const sessionId = String((session as { id: string }).id);
			backend.database
				.prepare(
					"INSERT INTO terminal_sessions (id, session_id, workspace_id, open_request_id, status, revision, term, rows, cols, last_event_sequence, ownership_epoch, last_consumer_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"terminal-1",
					sessionId,
					workspaceId,
					"terminal-open-1",
					"active",
					1,
					"xterm-256color",
					40,
					160,
					0,
					0,
					1,
					1,
					1,
				);

			await chat.createRun({
				sessionId,
				requestId: "request-1",
				providerId: "chat-lifecycle-provider",
				modelId: "chat-lifecycle-model",
				message: "run",
				serverInteractionMode: "terminal",
			});
			failUnbind = true;
			await waitFor(async () => !(await chat.hasActiveRun(sessionId)));

			expect(cleanup).toHaveBeenCalledOnce();
			expect(unbindTerminalRun).toHaveBeenCalledOnce();
			expect(lifecycle.getUsage(sessionId).total).toBe(0);
		} finally {
			await chat.close();
			await backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});
});

async function requestJson(
	handleRequest: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body: unknown,
): Promise<unknown> {
	const response = await handleRequest(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	expect(response.ok).toBe(true);
	return response.json();
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Condition was not met");
}
