import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createChatUserMessage } from "../src/domain/chat-attachment.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("context compaction runtime", () => {
	it.each([false, true])("preserves one failure identity for a new greeting (overflow: %s)", async (overflow) => {
		const faux = fauxProvider({ provider: "opencode-go", models: [{ id: "model", contextWindow: 128_000 }] });
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: overflow ? "400: context_length_exceeded" : "400 status code (no body)",
			}),
		]);
		const backend = createBackend(faux);
		try {
			const { sessionId } = await createSession(backend.handleRequest);
			const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "greeting",
				providerId: "opencode-go",
				modelId: "model",
				message: "你好",
				serverInteractionMode: "command",
			});
			expect(created.status).toBe(201);
			await waitForRun(backend.handleRequest, sessionId);
			const runId = (created.body as { id: string }).id;
			const repository = new SqliteChatRepository(backend.database);
			const failure = repository.findRun(runId, sessionId)!.failure!;
			expect(failure).toMatchObject({
				schemaVersion: 1,
				errorId: expect.any(String),
				code: overflow ? "chat_context_overflow" : "chat_provider_request_rejected",
				retryable: false,
				upstreamStatus: 400,
			});
			if (overflow)
				expect(failure.recovery).toMatchObject({
					errorId: expect.any(String),
					code: "chat_context_no_compactable_history",
				});
			else expect(failure.recovery).toBeUndefined();
			expect(faux.state.callCount).toBe(1);
			for (const locale of ["zh-CN", "en-US"]) {
				const response = await backend.handleRequest(
					new Request(`http://localhost/api/sessions/${sessionId}/chat/messages?locale=${locale}`),
				);
				const body = (await response.json()) as {
					messages: { message: { failure?: { errorId: string; recovery?: { message: string } } } }[];
				};
				expect(body.messages.at(-1)!.message.failure?.errorId).toBe(failure.errorId);
				const stream = await backend.handleRequest(
					new Request(`http://localhost/api/sessions/${sessionId}/chat/runs/${runId}/events?locale=${locale}`),
				);
				const reader = stream.body!.getReader();
				const frames: string[] = [];
				try {
					while (true) {
						const next = await reader.read();
						if (next.done) break;
						const frame = new TextDecoder().decode(next.value);
						frames.push(frame);
						if (frame.includes("event: run.updated") && frame.includes('"status":"failed"')) break;
					}
				} finally {
					await reader.cancel();
				}
				for (const type of ["message_end", "agent_end", "run.updated"])
					expect(frames.filter((frame) => frame.includes(`event: ${type}\n`)).at(-1)).toContain(failure.errorId);
				if (!overflow) {
					const text = frames.join("");
					expect(text).not.toContain("compaction.");
					expect(text).toContain(locale === "zh-CN" ? "厂商未返回错误详情" : "no error details");
				}
			}
		} finally {
			await backend.close();
		}
	});

	it("holds a failed terminal commit until reconciliation without replaying the model", async () => {
		const faux = fauxProvider({ provider: "commit-failure", models: [{ id: "model", contextWindow: 128_000 }] });
		faux.setResponses([fauxAssistantMessage("done")]);
		const backend = createBackend(faux);
		try {
			const { sessionId } = await createSession(backend.handleRequest);
			backend.database.exec(
				"CREATE TRIGGER fail_terminal BEFORE UPDATE ON chat_runs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END",
			);
			const input = {
				requestId: "commit",
				providerId: "commit-failure",
				modelId: "model",
				message: "hello",
				serverInteractionMode: "command",
			};
			const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, input);
			const runId = (created.body as { id: string }).id;
			let failed = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				const active = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
				if (active.status === 503) {
					failed = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(failed).toBe(true);
			expect(new SqliteChatRepository(backend.database).findRun(runId, sessionId)?.status).toBe("running");
			expect(
				await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
					...input,
					requestId: "second",
				}),
			).toMatchObject({ status: 503, body: { error: { code: "chat_persistence_failed" } } });
			backend.database.exec("DROP TRIGGER fail_terminal");
			await waitForRun(backend.handleRequest, sessionId);
			expect(new SqliteChatRepository(backend.database).findRun(runId, sessionId)?.status).toBe("completed");
			expect(faux.state.callCount).toBe(1);
		} finally {
			await backend.close();
		}
	});

	it.each([false, true])(
		"keeps chat error reasons in history and all replay events (after tool: %s)",
		async (afterTool) => {
			const faux = fauxProvider({ provider: "chat-errors", models: [{ id: "model", contextWindow: 128_000 }] });
			const failure = fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '429: {"error":{"code":"insufficient_quota","message":"Insufficient balance"}}',
			});
			faux.setResponses(
				afterTool
					? [
							fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }), { stopReason: "toolUse" }),
							failure,
						]
					: [failure],
			);
			const backend = createBackend(faux);
			try {
				const { sessionId } = await createSession(backend.handleRequest);
				const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
					requestId: "chat-errors",
					providerId: "chat-errors",
					modelId: "model",
					message: "hello",
					serverInteractionMode: "command",
				});
				await waitForRun(backend.handleRequest, sessionId);
				const runId = (created.body as { id: string }).id;
				const row = backend.database.prepare("SELECT failure_json FROM chat_runs WHERE id = ?").get(runId)!;
				expect(JSON.parse(String(row.failure_json))).toMatchObject({
					code: "chat_provider_request_rejected",
					messageKey: "provider.request_failed",
					retryable: false,
				});
				for (const locale of ["zh-CN", "en-US"]) {
					const messages = await backend.handleRequest(
						new Request(`http://localhost/api/sessions/${sessionId}/chat/messages`, {
							headers: { "Accept-Language": locale },
						}),
					);
					const text = await messages.text();
					expect(text).toContain("Insufficient balance (HTTP 429)");
					expect(text).not.toMatch(/providerFailure|errorMessageDescriptor|diagnostics/);
					const response = await backend.handleRequest(
						new Request(`http://localhost/api/sessions/${sessionId}/chat/runs/${runId}/events?locale=${locale}`),
					);
					const reader = response.body!.getReader();
					const frames: string[] = [];
					try {
						while (true) {
							const next = await reader.read();
							if (next.done) break;
							const frame = new TextDecoder().decode(next.value);
							frames.push(frame);
							if (frame.includes("event: run.updated") && frame.includes('"status":"failed"')) break;
						}
					} finally {
						await reader.cancel();
					}
					for (const type of ["message_end", "turn_end", "agent_end", "run.updated"])
						expect(frames.filter((frame) => frame.includes(`event: ${type}\n`)).at(-1)).toContain(
							"Insufficient balance (HTTP 429)",
						);
					expect(frames.join("")).not.toMatch(/providerFailure|errorMessageDescriptor|diagnostics/);
				}
				expect(faux.state.callCount).toBe(afterTool ? 2 : 1);
			} finally {
				await backend.close();
			}
		},
	);
	it.each([
		["manual", false],
		["automatic", false],
		["manual", true],
		["automatic", true],
	] as const)("preserves provider failure through %s compaction (turn prefix: %s)", async (mode, prefix) => {
		const faux = fauxProvider({
			provider: "compaction-errors",
			models: [{ id: "model", contextWindow: 4_000, maxTokens: 1_000 }],
		});
		faux.setResponses([
			...(prefix ? [fauxAssistantMessage("history summary")] : []),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					'403: {"error":{"code":"unsupported_country_region_territory","message":"Country not supported"}}',
			}),
		]);
		const backend = createBackend(faux);
		try {
			const { sessionId, workspaceId } = await createSession(backend.handleRequest);
			insertHistory(backend.database, {
				sessionId,
				workspaceId,
				providerId: "compaction-errors",
				modelId: "model",
				turns: 4,
				charactersPerMessage: 2_000,
			});
			if (mode === "manual") {
				const response = await request(
					backend.handleRequest,
					"POST",
					`/api/sessions/${sessionId}/chat/compactions`,
				);
				expect(response).toMatchObject({
					status: 502,
					body: {
						error: {
							code: "chat_context_compaction_failed",
							message: "上下文压缩失败：Country not supported (HTTP 403)",
							retryable: false,
						},
					},
				});
			} else {
				const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
					requestId: "errors",
					providerId: "compaction-errors",
					modelId: "model",
					message: "continue",
					serverInteractionMode: "command",
				});
				await waitForRun(backend.handleRequest, sessionId);
				const runId = (created.body as { id: string }).id;
				const row = backend.database.prepare("SELECT failure_json FROM chat_runs WHERE id = ?").get(runId)!;
				expect(JSON.parse(String(row.failure_json))).toMatchObject({
					code: "chat_context_compaction_failed",
					messageKey: "provider.compaction_failed",
					retryable: false,
				});
				const messages = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/messages`);
				expect(JSON.stringify(messages.body)).toContain("上下文压缩失败：Country not supported (HTTP 403)");
				const response = await backend.handleRequest(
					new Request(`http://localhost/api/sessions/${sessionId}/chat/runs/${runId}/events`),
				);
				const reader = response.body!.getReader();
				const frames: string[] = [];
				try {
					while (true) {
						const next = await reader.read();
						if (next.done) break;
						const frame = new TextDecoder().decode(next.value);
						frames.push(frame);
						if (frame.includes("event: run.updated") && frame.includes('"status":"failed"')) break;
					}
				} finally {
					await reader.cancel();
				}
				for (const type of ["compaction.failed", "message_end", "agent_end", "run.updated"]) {
					expect(frames.filter((frame) => frame.includes(`event: ${type}\n`)).at(-1)).toContain(
						"上下文压缩失败：Country not supported (HTTP 403)",
					);
				}
				expect(frames.join("")).not.toMatch(/providerFailure|errorMessageDescriptor|diagnostics/);
			}
		} finally {
			await backend.close();
		}
	});
	it.each(["command", "terminal"] as const)(
		"restores %s usage from a compact boundary after restart without reading images",
		async (mode) => {
			const directory = await mkdtemp(join(tmpdir(), "ssh-context-usage-"));
			const databasePath = join(directory, "db.sqlite");
			const faux = fauxProvider({ provider: "usage-restart", models: [{ id: "model", contextWindow: 128_000 }] });
			let backend = createBackend(faux, databasePath);
			try {
				const { sessionId, workspaceId } = await createSession(backend.handleRequest);
				insertHistory(backend.database, {
					sessionId,
					workspaceId,
					providerId: "usage-restart",
					modelId: "model",
					turns: 4,
					charactersPerMessage: 20_000,
				});
				backend.database.prepare("UPDATE chat_runs SET server_interaction_mode = ?").run(mode);
				const repository = new SqliteChatRepository(backend.database);
				expect(repository.findLatestRun(sessionId)?.serverInteractionMode).toBe(mode);
				repository.appendCompaction(
					"compact-restart",
					sessionId,
					null,
					{
						role: "compactionSummary",
						summary: "summary",
						retainedTail: [createChatUserMessage("image", ["not-on-disk"], 20)],
						tokensBefore: 40_000,
						reason: "manual",
						attempt: 1,
						provider: "usage-restart",
						model: "model",
						timestamp: 30,
					},
					30,
				);
				const path = `/api/sessions/${sessionId}/chat/context-usage`;
				const before = await request(backend.handleRequest, "GET", path);
				expect(before.status).toBe(200);
				const tokens = (before.body as { contextUsage: { contextTokens: number } }).contextUsage.contextTokens;
				expect(tokens).toBeGreaterThan(1_200);
				expect(tokens).toBeLessThan(5_000);
				await backend.close();
				backend = createBackend(faux, databasePath);
				expect(await request(backend.handleRequest, "GET", path)).toEqual(before);
				expect(faux.state.callCount).toBe(0);
			} finally {
				await backend.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
	it("queries idle usage and replays one snapshot per Turn including tool results", async () => {
		const faux = fauxProvider({ provider: "usage-turns", models: [{ id: "model", contextWindow: 128_000 }] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const backend = createBackend(faux);
		try {
			const { sessionId } = await createSession(backend.handleRequest);
			const path = `/api/sessions/${sessionId}/chat/context-usage`;
			expect(await request(backend.handleRequest, "GET", path)).toEqual({
				status: 200,
				body: { contextUsage: null },
			});
			expect(await request(backend.handleRequest, "GET", "/api/sessions/missing/chat/context-usage")).toMatchObject({
				status: 404,
				body: { error: { code: "chat_session_not_found" } },
			});
			const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "usage",
				providerId: "usage-turns",
				modelId: "model",
				message: "read package.json",
				serverInteractionMode: "command",
			});
			expect(created.status).toBe(201);
			await waitForRun(backend.handleRequest, sessionId);
			const runId = (created.body as { id: string }).id;
			const response = await backend.handleRequest(
				new Request(`http://localhost/api/sessions/${sessionId}/chat/runs/${runId}/events?locale=en-US`),
			);
			const reader = response.body!.getReader();
			const frames: string[] = [];
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					const frame = new TextDecoder().decode(next.value);
					frames.push(frame);
					if (frame.includes("event: run.updated") && frame.includes('"status":"completed"')) break;
				}
			} finally {
				await reader.cancel();
			}
			const types = frames.map((frame) => frame.match(/event: ([^\n]+)/)?.[1]);
			expect(types.filter((type) => type === "turn_end")).toHaveLength(2);
			expect(types.filter((type) => type === "context.updated")).toHaveLength(2);
			for (const [index, type] of types.entries()) {
				if (type === "context.updated") expect(types[index - 1]).toBe("turn_end");
			}
			const latest = frames.filter((frame) => frame.includes("event: context.updated")).at(-1)!;
			const snapshot = JSON.parse(latest.match(/data: ([^\n]+)/)![1]);
			expect(await request(backend.handleRequest, "GET", path)).toEqual({
				status: 200,
				body: { contextUsage: snapshot },
			});
			expect(snapshot).toMatchObject({ source: "estimated", providerId: "usage-turns", contextWindow: 128_000 });
			expect(snapshot.contextTokens).toBeGreaterThan(0);
			expect(faux.state.callCount).toBe(2);
			backend.database.prepare("UPDATE chat_runs SET model_id = 'removed' WHERE id = ?").run(runId);
			expect(await request(backend.handleRequest, "GET", path)).toEqual({
				status: 200,
				body: { contextUsage: null },
			});
		} finally {
			await backend.close();
		}
	});
	it("compacts persisted history before the provider request", async () => {
		const faux = fauxProvider({
			provider: "compaction-preflight",
			models: [{ id: "model", contextWindow: 4_000, maxTokens: 1_000 }],
		});
		faux.setResponses([
			fauxAssistantMessage("history summary"),
			fauxAssistantMessage("turn summary"),
			async () => {
				const row = backend.database.prepare("SELECT session_id FROM chat_runs ORDER BY rowid DESC LIMIT 1").get();
				const response = await request(
					backend.handleRequest,
					"GET",
					`/api/sessions/${row!.session_id}/chat/context-usage`,
				);
				const usage = (response.body as { contextUsage: { contextTokens: number } }).contextUsage;
				// Original persisted history alone exceeds 4,000 tokens; active usage must honor the compact boundary.
				expect(usage.contextTokens).toBeLessThan(3_200);
				return fauxAssistantMessage("provider response");
			},
		]);
		const backend = createBackend(faux);
		try {
			const { sessionId, workspaceId } = await createSession(backend.handleRequest);
			insertHistory(backend.database, {
				sessionId,
				workspaceId,
				providerId: "compaction-preflight",
				modelId: "model",
				turns: 4,
				charactersPerMessage: 2_000,
			});

			const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "preflight",
				providerId: "compaction-preflight",
				modelId: "model",
				message: "continue",
				serverInteractionMode: "command",
			});
			expect(created.status).toBe(201);
			await waitForRun(backend.handleRequest, sessionId);

			const compactRows = backend.database
				.prepare("SELECT run_id, message_type, message_json FROM chat_messages WHERE message_type = 'compact'")
				.all() as Array<Record<string, unknown>>;
			expect(compactRows).toHaveLength(1);
			expect(compactRows[0]).toMatchObject({ run_id: (created.body as { id: string }).id, message_type: "compact" });
			expect(JSON.parse(String(compactRows[0]?.message_json))).toMatchObject({
				role: "compactionSummary",
				reason: "threshold",
				attempt: 1,
			});
			expect(faux.state.callCount).toBe(3);
		} finally {
			await backend.close();
		}
	});

	it("compacts and retries once after an uncommitted provider overflow", async () => {
		const faux = fauxProvider({
			provider: "compaction-overflow",
			models: [{ id: "model", contextWindow: 4_000, maxTokens: 1_000 }],
		});
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "400 prompt too long; exceeded max context length by 1000 tokens",
			}),
			fauxAssistantMessage("history summary"),
			fauxAssistantMessage("turn summary"),
			fauxAssistantMessage("recovered"),
		]);
		const backend = createBackend(faux);
		try {
			const { sessionId, workspaceId } = await createSession(backend.handleRequest);
			insertHistory(backend.database, {
				sessionId,
				workspaceId,
				providerId: "compaction-overflow",
				modelId: "model",
				turns: 4,
				charactersPerMessage: 1_000,
			});

			const created = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "overflow",
				providerId: "compaction-overflow",
				modelId: "model",
				message: "continue",
				serverInteractionMode: "command",
			});
			await waitForRun(backend.handleRequest, sessionId);

			const runId = (created.body as { id: string }).id;
			const currentRunMessages = backend.database
				.prepare("SELECT message_type, message_json FROM chat_messages WHERE run_id = ? ORDER BY sequence")
				.all(runId) as Array<Record<string, unknown>>;
			expect(currentRunMessages.map((row) => row.message_type)).toEqual(["user", "compact", "assistant"]);
			expect(
				currentRunMessages.some((row) => JSON.parse(String(row.message_json)).errorCode === "context_overflow"),
			).toBe(false);
			expect(JSON.parse(String(currentRunMessages.at(-1)?.message_json))).toMatchObject({
				stopReason: "stop",
				content: [{ type: "text", text: "recovered" }],
			});
			expect(faux.state.callCount).toBe(4);
		} finally {
			await backend.close();
		}
	});

	it("uses the same compactor for a manual request and keeps run_id null", async () => {
		const faux = fauxProvider({
			provider: "compaction-manual",
			models: [{ id: "model", contextWindow: 4_000, maxTokens: 1_000 }],
		});
		faux.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("turn summary")]);
		const backend = createBackend(faux);
		try {
			const { sessionId, workspaceId } = await createSession(backend.handleRequest);
			insertHistory(backend.database, {
				sessionId,
				workspaceId,
				providerId: "compaction-manual",
				modelId: "model",
				turns: 4,
				charactersPerMessage: 2_000,
			});
			const settings = await request(backend.handleRequest, "GET", "/api/settings/compaction");
			const revision = (settings.body as { revision: number }).revision;
			const updatedSettings = await request(
				backend.handleRequest,
				"PUT",
				`/api/settings/compaction?expectedRevision=${revision}`,
				{
					triggerPercent: 80,
					model: { providerId: "anthropic", modelId: "claude-sonnet-test" },
				},
			);
			expect(updatedSettings.status).toBe(200);

			const response = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/compactions`);

			expect(response).toMatchObject({
				status: 200,
				body: {
					status: "completed",
					contextUsage: { source: "estimated", providerId: "compaction-manual", contextWindow: 4_000 },
					reason: "manual",
					attempts: 1,
					message: { message: { role: "compactionSummary", reason: "manual" } },
					model: { providerId: "compaction-manual", modelId: "model", fallback: true },
				},
			});
			const usage = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/context-usage`);
			expect(usage.body).toEqual({ contextUsage: (response.body as { contextUsage: unknown }).contextUsage });
			const skipped = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/compactions`);
			expect(skipped).toMatchObject({
				status: 200,
				body: {
					status: "skipped",
					contextUsage: (response.body as { contextUsage: unknown }).contextUsage,
				},
			});
			expect(
				backend.database.prepare("SELECT run_id FROM chat_messages WHERE message_type = 'compact'").get(),
			).toEqual({
				run_id: null,
			});
		} finally {
			await backend.close();
		}
	});

	it("rejects manual compaction while a Chat Run is active", async () => {
		let release: ((message: ReturnType<typeof fauxAssistantMessage>) => void) | undefined;
		const pending = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			release = resolve;
		});
		const faux = fauxProvider({
			provider: "compaction-busy",
			models: [{ id: "model", contextWindow: 4_000, maxTokens: 1_000 }],
		});
		faux.setResponses([async () => pending]);
		const backend = createBackend(faux);
		try {
			const { sessionId } = await createSession(backend.handleRequest);
			await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/runs`, {
				requestId: "busy",
				providerId: "compaction-busy",
				modelId: "model",
				message: "wait",
				serverInteractionMode: "command",
			});

			const response = await request(backend.handleRequest, "POST", `/api/sessions/${sessionId}/chat/compactions`);

			expect(response).toMatchObject({ status: 409, body: { error: { code: "chat_session_busy" } } });
			const before = await request(backend.handleRequest, "GET", `/api/sessions/${sessionId}/chat/context-usage`);
			expect(before).toMatchObject({
				status: 200,
				body: { contextUsage: { source: "estimated", providerId: "compaction-busy" } },
			});
			expect(faux.state.callCount).toBe(1);
			release?.(fauxAssistantMessage("done"));
			await waitForRun(backend.handleRequest, sessionId);
		} finally {
			release?.(fauxAssistantMessage("done"));
			await backend.close();
		}
	});
});

function createBackend(faux: ReturnType<typeof fauxProvider>, databasePath = ":memory:") {
	return createSqliteManagementBackend({
		databasePath,
		credentialEncryptionKey: new Uint8Array(32).fill(7),
		clock: { now: () => 1_000 },
		llmModelsFactory: (credentials) => {
			const models = createTestLlmModels(credentials);
			models.setProvider(faux.provider);
			return models;
		},
	});
}

async function createSession(
	handleRequest: (request: Request) => Promise<Response>,
): Promise<{ workspaceId: string; sessionId: string }> {
	const workspace = await request(handleRequest, "POST", "/api/workspaces", {
		displayName: "workspace",
		environment: "development",
		host: { hostname: "localhost", port: 22 },
		credential: { displayName: "root", remoteUser: "root", type: "password", password: "password" },
		defaultCwd: "/tmp",
	});
	const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
	const session = await request(handleRequest, "POST", `/api/workspaces/${workspaceId}/sessions`, {
		displayName: "session",
	});
	return { workspaceId, sessionId: (session.body as { id: string }).id };
}

function insertHistory(
	database: ReturnType<typeof createSqliteManagementBackend>["database"],
	input: {
		sessionId: string;
		workspaceId: string;
		providerId: string;
		modelId: string;
		turns: number;
		charactersPerMessage: number;
	},
): void {
	database
		.prepare(
			"INSERT INTO chat_runs (id, session_id, workspace_id, request_id, provider_id, model_id, thinking_level, server_interaction_mode, terminal_session_id, status, created_at, started_at, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'off', 'command', NULL, 'completed', 1, 1, 1, 1)",
		)
		.run("history-run", input.sessionId, input.workspaceId, "history", input.providerId, input.modelId);
	const insertMessage = database.prepare(
		"INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, provider, usage_json, message_json, created_at) VALUES (?, ?, 'history-run', ?, ?, ?, ?, ?, ?)",
	);
	for (let index = 0; index < input.turns; index += 1) {
		const userMessage = { role: "user", content: "u".repeat(input.charactersPerMessage), timestamp: index * 2 + 1 };
		insertMessage.run(
			`history-user-${index}`,
			input.sessionId,
			index * 2 + 1,
			"user",
			null,
			null,
			JSON.stringify(userMessage),
			userMessage.timestamp,
		);
		const assistantMessage = {
			...fauxAssistantMessage("a".repeat(input.charactersPerMessage), { timestamp: index * 2 + 2 }),
			provider: input.providerId,
			model: input.modelId,
		};
		insertMessage.run(
			`history-assistant-${index}`,
			input.sessionId,
			index * 2 + 2,
			"assistant",
			input.providerId,
			JSON.stringify(assistantMessage.usage),
			JSON.stringify(assistantMessage),
			assistantMessage.timestamp,
		);
	}
}

async function waitForRun(handleRequest: (request: Request) => Promise<Response>, sessionId: string): Promise<void> {
	for (let index = 0; index < 100; index += 1) {
		const response = await request(handleRequest, "GET", `/api/sessions/${sessionId}/chat/runs/active`);
		if ((response.body as { run: unknown }).run === null) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for Chat Run");
}

interface HttpResult {
	status: number;
	body: unknown;
}

async function request(
	handleRequest: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<HttpResult> {
	const response = await handleRequest(
		new Request(`http://localhost${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}
