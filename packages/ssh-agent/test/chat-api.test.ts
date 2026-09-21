import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ChatPromptService } from "../src/application/services/chat-prompt-service.ts";
import { SqliteChatPromptRepository } from "../src/infrastructure/sqlite/sqlite-chat-prompt-repository.ts";
import { SqliteWorkspaceRepository } from "../src/infrastructure/sqlite/sqlite-workspace-repository.ts";
import { ChatAttachmentService } from "../src/application/services/chat-attachment-service.ts";
import { createChatService } from "../src/application/services/create-chat-service.ts";
import { progressToolUpdate } from "../src/application/tool-update-protocol.ts";
import { SqliteAttachmentRepository } from "../src/infrastructure/sqlite/sqlite-attachment-repository.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";

describe("SSH Agent Chat API", () => {
	it("removes a remotely rejected model and returns a stable friendly failure", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-model-removed-"));
		const faux = fauxProvider({
			provider: "chat-faux-removed",
			models: [{ id: "retired-model", contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([
			{
				...fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: '401: {"type":"ModelError","message":"Model retired-model is not supported"}',
				}),
				diagnostics: [
					{
						type: "pi_messages_response_failure",
						timestamp: 1,
						details: {
							provider: "chat-faux-removed",
							model: "retired-model",
							body: '{"type":"ModelError","message":"Model retired-model is not supported"}',
						},
					},
				],
			},
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 15),
			localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "chat",
			});
			const sessionId = String((session.body as { id: string }).id);
			const created = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "removed-model-1",
				providerId: "chat-faux-removed",
				modelId: "retired-model",
				message: "hello",
				serverInteractionMode: "command",
			});
			const runId = String((created.body as { id: string }).id);
			await waitFor(async () => {
				const active = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (active.body as { run: unknown }).run === null;
			});
			expect(backend.llmModelCatalog.getModels("chat-faux-removed")).toEqual([]);
			const row = backend.database.prepare("SELECT failure_json FROM chat_runs WHERE id = ?").get(runId) as {
				failure_json: string;
			};
			expect(JSON.parse(row.failure_json)).toMatchObject({
				code: "chat_model_not_supported",
				message:
					"The selected model was removed. Select another model. Provider reason: Model retired-model is not supported (HTTP 401)",
				messageKey: "provider.model_removed",
				messageValues: { reason: "Model retired-model is not supported (HTTP 401)" },
				retryable: false,
			});
			const retry = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "removed-model-2",
				providerId: "chat-faux-removed",
				modelId: "retired-model",
				message: "retry",
				serverInteractionMode: "command",
			});
			expect(retry).toMatchObject({
				status: 404,
				body: { error: { code: "chat_model_not_found", message: "当前模型不可用，请重新选择模型。" } },
			});
		} finally {
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});

	it("streams and persists a faux Agent Run", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-"));
		const faux = fauxProvider({
			provider: "chat-faux",
			models: [{ id: "chat-model", reasoning: true, contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([fauxAssistantMessage("hello from chat"), fauxAssistantMessage("reused model")]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 7),
			localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "chat",
			});
			const sessionId = String((session.body as { id: string }).id);
			const created = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "request-1",
				providerId: "chat-faux",
				modelId: "chat-model",
				thinkingLevel: "medium",
				message: "hello",
				serverInteractionMode: "command",
			});
			expect(created.status).toBe(201);
			const runId = String((created.body as { id: string }).id);

			const stream = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${sessionId}/chat/runs/${runId}/events`),
			);
			expect(stream.headers.get("content-type")).toBe("text/event-stream");
			const reader = stream.body!.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain("stream.ready");
			await reader.cancel();

			await waitFor(async () => {
				const messages = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages`);
				return JSON.stringify(messages.body).includes("hello from chat");
			});
			const messages = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages`);
			expect(JSON.stringify(messages.body)).toContain("hello from chat");
			expect(faux.state.callCount).toBe(1);
			const active = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
			expect(active).toEqual({ status: 200, body: { run: null } });
			const sessionDetails = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}`);
			expect(sessionDetails.body).toMatchObject({
				id: sessionId,
				chatModelSelection: {
					providerId: "chat-faux",
					modelId: "chat-model",
					thinkingLevel: "medium",
				},
			});

			const reused = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "request-2",
				message: "continue",
				serverInteractionMode: "command",
			});
			expect(reused.body).toMatchObject({
				providerId: "chat-faux",
				modelId: "chat-model",
				thinkingLevel: "medium",
			});
			await waitFor(async () => {
				const result = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (result.body as { run: unknown }).run === null;
			});
			expect(faux.state.callCount).toBe(2);

			const unsupported = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "request-3",
				providerId: "chat-faux",
				modelId: "chat-model",
				thinkingLevel: "xhigh",
				message: "continue with unsupported thinking",
				serverInteractionMode: "command",
			});
			expect(unsupported).toMatchObject({
				status: 400,
				body: { error: { code: "chat_thinking_level_unsupported" } },
			});
		} finally {
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});

	it("returns the active Run and pending Queue for refresh recovery", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-active-"));
		const faux = fauxProvider({
			provider: "chat-faux-active",
			models: [{ id: "chat-model", contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "hello" }), {
				stopReason: "toolUse",
			}),
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 8),
			localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "chat",
			});
			const sessionId = String((session.body as { id: string }).id);
			const created = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "request-active",
				providerId: "chat-faux-active",
				modelId: "chat-model",
				message: "write a note",
				serverInteractionMode: "command",
			});
			const runId = String((created.body as { id: string }).id);
			await waitFor(async () => {
				const approvals = await json(
					backend.handleRequest,
					"GET",
					`/api/sessions/${sessionId}/chat/approvals?status=pending`,
				);
				return (approvals.body as { approvals: unknown[] }).approvals.length === 1;
			});

			const active = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
			expect((active.body as { run: { id: string; status: string } }).run).toMatchObject({
				id: runId,
				status: "running",
			});

			await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs/${runId}/queue`, {
				requestId: "queue-active",
				behavior: "follow_up",
				message: "then summarize",
			});
			const queue = await json(
				backend.handleRequest,
				"GET",
				`/api/sessions/${sessionId}/chat/runs/${runId}/queue?status=pending`,
			);
			expect(queue.body).toMatchObject({
				items: [{ runId, requestId: "queue-active", behavior: "follow_up", status: "pending" }],
			});

			const queuedItem = (queue.body as { items: Array<{ id: string }> }).items[0]!;
			const promotePath = `/api/sessions/${sessionId}/chat/runs/${runId}/queue/${queuedItem.id}/steer`;
			const promoted = await json(backend.handleRequest, "POST", promotePath);
			expect(promoted).toMatchObject({
				status: 200,
				body: { id: queuedItem.id, behavior: "steer", status: "pending", requestId: "queue-active" },
			});
			expect(await json(backend.handleRequest, "POST", promotePath)).toEqual(promoted);
			const refreshed = await json(
				backend.handleRequest,
				"GET",
				`/api/sessions/${sessionId}/chat/runs/${runId}/queue`,
			);
			expect(refreshed.body).toEqual({ items: [promoted.body] });
			expect(
				await json(
					backend.handleRequest,
					"POST",
					`/api/sessions/${sessionId}/chat/runs/${runId}/queue/missing/steer`,
				),
			).toMatchObject({ status: 404 });

			await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs/${runId}/cancel`);
			await waitFor(async () => {
				const result = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (result.body as { run: unknown }).run === null;
			});
			const cancelled = await json(
				backend.handleRequest,
				"GET",
				`/api/sessions/${sessionId}/chat/runs/${runId}/queue?status=cancelled`,
			);
			expect(cancelled.body).toMatchObject({ items: [{ requestId: "queue-active", status: "cancelled" }] });
			expect(await json(backend.handleRequest, "POST", promotePath)).toMatchObject({ status: 409 });
			const rejectedApprovals = await json(
				backend.handleRequest,
				"GET",
				`/api/sessions/${sessionId}/chat/approvals?status=rejected`,
			);
			expect(rejectedApprovals.body).toMatchObject({ approvals: [{ rejectionReason: "run_cancelled" }] });
		} finally {
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});

	it("auto-approves remote calls without allowing autoAudit to bypass Guard", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-auto-remote-"));
		const faux = fauxProvider({
			provider: "chat-faux-auto-remote",
			models: [{ id: "chat-model", contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "echo allowed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("allowed command completed"),
			fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "rm -rf /" }), {
				stopReason: "toolUse",
			}),
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 11),
			localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		const executedCommands: string[] = [];
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
			ids: {
				next: () => {
					nextId += 1;
					return `chat-test-${nextId}`;
				},
			},
			createRemoteTool: () => ({
				name: "remote_server_call",
				label: "Remote server command",
				description: "Execute a command on the remote server",
				parameters: Type.Object({ command: Type.String() }),
				execute: (_toolCallId, params) => {
					executedCommands.push((params as { command: string }).command);
					return Promise.resolve({ content: [{ type: "text", text: "remote command completed" }], details: {} });
				},
			}),
			createTerminalTool: () => ({
				name: "terminal_interaction",
				label: "Terminal interaction",
				description: "unused",
				parameters: Type.Object({ action: Type.String() }),
				execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
			}),
			bindServerInteraction: async (_sessionId, _runId, mode) => (mode === "command" ? null : "terminal-1"),
			unbindTerminalRun: async () => undefined,
			terminalInteractions: backend.terminalInteractions,
			createSftpTool: () => ({
				name: "sftp_upload",
				label: "SFTP file upload",
				description: "Upload a local file to a remote directory",
				parameters: Type.Object({ sourceFilePath: Type.String(), targetPath: Type.String() }),
				execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
			}),
			createSftpDownloadTool: () => ({
				name: "sftp_download",
				label: "SFTP file download",
				description: "Download a remote file to a local directory",
				parameters: Type.Object({ remoteFilePath: Type.String(), targetPath: Type.String() }),
				execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
			}),
			preflightRemoteGuard: (_sessionId, command) =>
				Promise.resolve(
					command.includes("rm -rf")
						? { allowed: false, reason: "Destructive command blocked by Guard" }
						: { allowed: true },
				),
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
			const allowedSession = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "allowed",
				autoAudit: true,
			});
			const allowedSessionId = String((allowedSession.body as { id: string }).id);
			await chat.createRun({
				sessionId: allowedSessionId,
				requestId: "auto-remote-allowed",
				providerId: "chat-faux-auto-remote",
				modelId: "chat-model",
				message: "run an allowed remote command",
				serverInteractionMode: "command",
			});
			await waitFor(async () => !(await chat.hasActiveRun(allowedSessionId)));
			expect(chat.listApprovals(allowedSessionId, "approved")).toMatchObject([
				{ toolName: "remote_server_call", status: "approved", source: "auto" },
			]);
			expect(executedCommands).toEqual(["echo allowed"]);

			const blockedSession = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "blocked",
				autoAudit: true,
			});
			const blockedSessionId = String((blockedSession.body as { id: string }).id);
			await chat.createRun({
				sessionId: blockedSessionId,
				requestId: "auto-remote-blocked",
				providerId: "chat-faux-auto-remote",
				modelId: "chat-model",
				message: "run a blocked remote command",
				serverInteractionMode: "command",
			});
			await waitFor(async () => !(await chat.hasActiveRun(blockedSessionId)));
			expect(chat.listApprovals(blockedSessionId)).toEqual([]);
			expect(executedCommands).toEqual(["echo allowed"]);
			const messages = chat.listMessages(blockedSessionId, { direction: "after", sequence: 0 }, 100);
			expect(JSON.stringify(messages)).toContain("Destructive command blocked by Guard");
			expect(faux.state.callCount).toBe(3);
		} finally {
			chat.close();
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});

	it("stops automatic continuation after rejection, cancels steer, and consumes follow-up", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-reject-"));
		const faux = fauxProvider({
			provider: "chat-faux-reject",
			models: [{ id: "chat-model", contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "rejected.txt", content: "must not exist" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("follow-up completed"),
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 9),
			localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "chat",
			});
			const sessionId = String((session.body as { id: string }).id);
			const created = await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "request-reject",
				providerId: "chat-faux-reject",
				modelId: "chat-model",
				message: "write a file",
				serverInteractionMode: "command",
			});
			const runId = String((created.body as { id: string }).id);
			let approvalId = "";
			await waitFor(async () => {
				const approvals = await json(
					backend.handleRequest,
					"GET",
					`/api/sessions/${sessionId}/chat/approvals?status=pending`,
				);
				const approval = (approvals.body as { approvals: Array<{ id: string }> }).approvals[0];
				approvalId = approval?.id ?? "";
				return approvalId !== "";
			});

			await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs/${runId}/queue`, {
				requestId: "steer-reject",
				behavior: "steer",
				message: "try another write",
			});
			await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs/${runId}/queue`, {
				requestId: "follow-up-reject",
				behavior: "follow_up",
				message: "explain what happened",
			});
			const rejected = await json(
				backend.handleRequest,
				"POST",
				`/api/sessions/${sessionId}/chat/approvals/${approvalId}/reject`,
			);
			expect(rejected.body).toMatchObject({
				status: "rejected",
				source: "user",
				rejectionReason: "user_rejected",
			});
			expect(
				await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/approvals/${approvalId}/reject`),
			).toEqual(rejected);
			expect(
				await json(
					backend.handleRequest,
					"POST",
					`/api/sessions/${sessionId}/chat/approvals/${approvalId}/approve`,
				),
			).toMatchObject({ status: 409, body: { error: { code: "approval_already_resolved" } } });

			await waitFor(async () => {
				const active = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (active.body as { run: unknown }).run === null;
			});
			const cancelled = await json(
				backend.handleRequest,
				"GET",
				`/api/sessions/${sessionId}/chat/runs/${runId}/queue?status=cancelled`,
			);
			expect(cancelled.body).toMatchObject({ items: [{ requestId: "steer-reject", behavior: "steer" }] });
			const consumed = await json(
				backend.handleRequest,
				"GET",
				`/api/sessions/${sessionId}/chat/runs/${runId}/queue?status=consumed`,
			);
			expect(consumed.body).toMatchObject({
				items: [{ requestId: "follow-up-reject", behavior: "follow_up" }],
			});
			const messages = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages`);
			expect(JSON.stringify(messages.body)).toContain(
				"Tool execution was rejected by the user. The tool was not executed.",
			);
			expect(JSON.stringify(messages.body)).toContain("explain what happened");
			expect(JSON.stringify(messages.body)).not.toContain("try another write");
			expect(faux.state.callCount).toBe(2);
			await expect(readFile(join(localCwd, "rejected.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});

	it("stops automatic continuation when approval times out", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-timeout-"));
		const faux = fauxProvider({
			provider: "chat-faux-timeout",
			models: [{ id: "chat-model", contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "timeout.txt", content: "must not exist" }), {
				stopReason: "toolUse",
			}),
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 10),
			localCwd,
			chatApprovalTimeoutMs: 10,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "chat",
			});
			const sessionId = String((session.body as { id: string }).id);
			await json(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "request-timeout",
				providerId: "chat-faux-timeout",
				modelId: "chat-model",
				message: "write a file",
				serverInteractionMode: "command",
			});
			await waitFor(async () => {
				const approvals = await json(
					backend.handleRequest,
					"GET",
					`/api/sessions/${sessionId}/chat/approvals?status=pending`,
				);
				return (approvals.body as { approvals: unknown[] }).approvals.length === 1;
			});

			await waitFor(async () => {
				const active = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				return (active.body as { run: unknown }).run === null;
			});
			const rejected = await json(
				backend.handleRequest,
				"GET",
				`/api/sessions/${sessionId}/chat/approvals?status=rejected`,
			);
			expect(rejected.body).toMatchObject({ approvals: [{ rejectionReason: "timeout" }] });
			const messages = await json(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages`);
			expect(JSON.stringify(messages.body)).toContain("Tool approval timed out. The tool was not executed.");
			expect(faux.state.callCount).toBe(1);
			await expect(readFile(join(localCwd, "timeout.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});

	it.each([false, true])(
		"requests overwrite authorization from inside sftp_upload with autoAudit=%s",
		async (autoAudit) => {
			const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-sftp-approval-"));
			const faux = fauxProvider({
				provider: "chat-faux-sftp-approval",
				models: [{ id: "chat-model", contextWindow: 128_000, maxTokens: 8_192 }],
			});
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("sftp_upload", { sourceFilePath: "release.tar", targetPath: "/srv/releases" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("upload completed"),
			]);
			const backend = createSqliteManagementBackend({
				databasePath: ":memory:",
				credentialEncryptionKey: Buffer.alloc(32, 13),
				localCwd,
				llmModelsFactory: (credentials) => {
					const models = createModels({ credentials });
					models.setProvider(faux.provider);
					return models;
				},
			});
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
				ids: { next: () => `sftp-chat-${++nextId}` },
				createRemoteTool: () => ({
					name: "remote_server_call",
					label: "Remote server command",
					description: "unused",
					parameters: Type.Object({ command: Type.String() }),
					execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
				}),
				createTerminalTool: () => ({
					name: "terminal_interaction",
					label: "Terminal interaction",
					description: "unused",
					parameters: Type.Object({ action: Type.String() }),
					execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
				}),
				bindServerInteraction: async (_sessionId, _runId, mode) => (mode === "command" ? null : "terminal-1"),
				unbindTerminalRun: async () => undefined,
				terminalInteractions: backend.terminalInteractions,
				createSftpTool: ({ requestOverwriteApproval }) => ({
					name: "sftp_upload",
					label: "SFTP file upload",
					description: "Upload a local file to a remote directory",
					parameters: Type.Object({ sourceFilePath: Type.String(), targetPath: Type.String() }),
					executionMode: "sequential",
					execute: async (toolCallId, params, signal, onUpdate) => {
						onUpdate?.({
							content: [{ type: "text", text: "private internal progress" }],
							details: {
								privatePath: "/private/release.tar",
								update: progressToolUpdate({
									current: 5,
									total: 10,
									unit: "bytes",
									message: "Uploading release.tar",
								}),
							},
						});
						const decision = await requestOverwriteApproval(
							toolCallId,
							{
								name: "release.tar",
								path: "/srv/releases/release.tar",
								type: "file",
								size: 10,
								modifiedAt: 1,
								permissions: 0o644,
							},
							signal ?? new AbortController().signal,
						);
						if (!decision.approved) throw new Error(decision.reason);
						return {
							content: [
								{ type: "text", text: `uploaded ${(params as { sourceFilePath: string }).sourceFilePath}` },
							],
							details: {},
						};
					},
				}),
				createSftpDownloadTool: () => ({
					name: "sftp_download",
					label: "SFTP file download",
					description: "unused",
					parameters: Type.Object({ remoteFilePath: Type.String(), targetPath: Type.String() }),
					execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
				}),
				preflightRemoteGuard: () => Promise.resolve({ allowed: true }),
			});
			try {
				const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
					displayName: "test",
					environment: "development",
					host: { hostname: "localhost", port: 22 },
					credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
					defaultCwd: "/tmp",
				});
				const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
				const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
					displayName: "sftp",
					autoAudit,
				});
				const sessionId = String((session.body as { id: string }).id);
				const run = await chat.createRun({
					sessionId,
					requestId: "sftp-overwrite",
					providerId: "chat-faux-sftp-approval",
					modelId: "chat-model",
					message: "upload release.tar",
					serverInteractionMode: "command",
				});
				if (autoAudit) {
					await waitFor(async () => !(await chat.hasActiveRun(sessionId)));
					expect(chat.listApprovals(sessionId)).toEqual([]);
					expect(chat.listApprovals(sessionId, "approved")).toMatchObject([
						{ toolName: "sftp_upload", status: "approved", source: "auto" },
					]);
					const reader = chat.subscribe(sessionId, run.id).getReader();
					const resolved = await readSseData(reader, "approval.resolved");
					expect(resolved).toMatchObject({ toolName: "sftp_upload", status: "approved", source: "auto" });
					await reader.cancel();
					expect(JSON.stringify(chat.listMessages(sessionId, { direction: "after", sequence: 0 }, 100))).toContain(
						"uploaded release.tar",
					);
					return;
				}
				let approvalId = "";
				await waitFor(async () => {
					approvalId = chat.listApprovals(sessionId)[0]?.id ?? "";
					return approvalId.length > 0;
				});
				const reader = chat.subscribe(sessionId, run.id).getReader();
				const update = await readSseData(reader, "tool_execution_update");
				expect(update).toEqual({
					type: "tool_execution_update",
					toolCallId: expect.any(String),
					toolName: "sftp_upload",
					update: {
						type: "progress",
						detail: {
							current: 5,
							total: 10,
							unit: "bytes",
							message: "Uploading release.tar",
						},
					},
				});
				expect(JSON.stringify(update)).not.toContain("privatePath");
				expect(JSON.stringify(update)).not.toContain("partialResult");
				expect(JSON.stringify(update)).not.toContain('"args"');
				const approvalRequested = await readSseData(reader, "approval.requested");
				expect(approvalRequested).toMatchObject({
					toolName: "sftp_upload",
					description: "远程文件 /srv/releases/release.tar 已存在。继续执行将覆盖该文件，是否继续执行？",
					status: "pending",
				});
				await reader.cancel();
				expect(chat.listApprovals(sessionId)).toMatchObject([
					{
						toolName: "sftp_upload",
						description:
							"Remote file /srv/releases/release.tar already exists. Continuing will overwrite it. Continue?",
						status: "pending",
					},
				]);
				chat.resolveApproval(sessionId, approvalId, true);
				await waitFor(async () => !(await chat.hasActiveRun(sessionId)));
				expect(chat.listApprovals(sessionId, "approved")).toMatchObject([
					{ toolName: "sftp_upload", status: "approved", source: "user" },
				]);
				expect(JSON.stringify(chat.listMessages(sessionId, { direction: "after", sequence: 0 }, 100))).toContain(
					"uploaded release.tar",
				);
			} finally {
				chat.close();
				backend.close();
				await rm(localCwd, { recursive: true, force: true });
			}
		},
	);

	it.each([false, true])("injects sftp_download and respects autoAudit=%s for local overwrite", async (autoAudit) => {
		const localCwd = await mkdtemp(join(tmpdir(), "ssh-agent-chat-sftp-download-"));
		const faux = fauxProvider({
			provider: "chat-faux-sftp-download",
			models: [{ id: "chat-model", contextWindow: 128_000, maxTokens: 8_192 }],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("sftp_download", { remoteFilePath: "/srv/releases/release.tar", targetPath: "downloads" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("download completed"),
		]);
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: Buffer.alloc(32, 14),
			localCwd,
			llmModelsFactory: (credentials) => {
				const models = createModels({ credentials });
				models.setProvider(faux.provider);
				return models;
			},
		});
		let nextId = 0;
		let downloadExecuted = false;
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
			ids: { next: () => `sftp-download-chat-${++nextId}` },
			createRemoteTool: () => ({
				name: "remote_server_call",
				label: "Remote server command",
				description: "unused",
				parameters: Type.Object({ command: Type.String() }),
				execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
			}),
			createTerminalTool: () => ({
				name: "terminal_interaction",
				label: "Terminal interaction",
				description: "unused",
				parameters: Type.Object({ action: Type.String() }),
				execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
			}),
			bindServerInteraction: async (_sessionId, _runId, mode) => (mode === "command" ? null : "terminal-1"),
			unbindTerminalRun: async () => undefined,
			terminalInteractions: backend.terminalInteractions,
			createSftpTool: () => ({
				name: "sftp_upload",
				label: "SFTP file upload",
				description: "unused",
				parameters: Type.Object({ sourceFilePath: Type.String(), targetPath: Type.String() }),
				execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
			}),
			createSftpDownloadTool: ({ requestOverwriteApproval }) => ({
				name: "sftp_download",
				label: "SFTP file download",
				description: "Download a remote file to a local directory",
				parameters: Type.Object({ remoteFilePath: Type.String(), targetPath: Type.String() }),
				executionMode: "sequential",
				execute: async (toolCallId, _params, signal) => {
					const decision = await requestOverwriteApproval(
						toolCallId,
						{ path: join(localCwd, "downloads/release.tar"), type: "file", size: 10, modifiedAt: 1 },
						signal ?? new AbortController().signal,
					);
					if (!decision.approved) throw new Error(decision.reason);
					downloadExecuted = true;
					return { content: [{ type: "text", text: "downloaded release.tar" }], details: {} };
				},
			}),
			preflightRemoteGuard: () => Promise.resolve({ allowed: true }),
		});
		try {
			const workspace = await json(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "test",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: { displayName: "root", remoteUser: "root", type: "password", password: "test" },
				defaultCwd: "/tmp",
			});
			const workspaceId = String((workspace.body as { workspace: { id: string } }).workspace.id);
			const session = await json(backend.handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
				displayName: "sftp download",
				autoAudit,
			});
			const sessionId = String((session.body as { id: string }).id);
			await chat.createRun({
				sessionId,
				requestId: "sftp-download-overwrite",
				providerId: "chat-faux-sftp-download",
				modelId: "chat-model",
				message: "download release.tar",
				serverInteractionMode: "command",
			});
			if (!autoAudit) {
				let approvalId = "";
				await waitFor(async () => {
					approvalId = chat.listApprovals(sessionId)[0]?.id ?? "";
					return approvalId.length > 0;
				});
				expect(downloadExecuted).toBe(false);
				expect(chat.listApprovals(sessionId)).toMatchObject([
					{
						toolName: "sftp_download",
						description: `Local file ${join(localCwd, "downloads/release.tar")} already exists. Continuing will overwrite it. Continue?`,
						status: "pending",
					},
				]);
				chat.resolveApproval(sessionId, approvalId, true);
			}
			await waitFor(async () => !(await chat.hasActiveRun(sessionId)));
			expect(downloadExecuted).toBe(true);
			expect(chat.listApprovals(sessionId)).toEqual([]);
			expect(chat.listApprovals(sessionId, "approved")).toMatchObject([
				{ toolName: "sftp_download", status: "approved", source: autoAudit ? "auto" : "user" },
			]);
			expect(JSON.stringify(chat.listMessages(sessionId, { direction: "after", sequence: 0 }, 100))).toContain(
				"downloaded release.tar",
			);
		} finally {
			chat.close();
			backend.close();
			await rm(localCwd, { recursive: true, force: true });
		}
	});
});

async function json(handler: (request: Request) => Promise<Response>, method: string, path: string, body?: unknown) {
	const response = await handler(
		new Request(`http://localhost${path}`, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		}),
	);
	return { status: response.status, body: await response.json() };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for Chat Run");
}

async function readSseData(reader: ReadableStreamDefaultReader<Uint8Array>, eventType: string): Promise<unknown> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = await reader.read();
		if (result.done) break;
		const event = new TextDecoder().decode(result.value);
		if (!event.includes(`event: ${eventType}\n`)) continue;
		const data = event
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6);
		if (data !== undefined) return JSON.parse(data) as unknown;
	}
	throw new Error(`SSE event not found: ${eventType}`);
}
