import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { ChatRunRuntime } from "../src/application/chat-run-runtime.ts";
import { ChatAttachmentService } from "../src/application/services/chat-attachment-service.ts";
import { createChatService } from "../src/application/services/create-chat-service.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import { SqliteAttachmentRepository } from "../src/infrastructure/sqlite/sqlite-attachment-repository.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

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
