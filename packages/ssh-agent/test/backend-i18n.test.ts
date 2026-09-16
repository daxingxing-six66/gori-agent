import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ChatRunEventStream } from "../src/application/chat-run-event-stream.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { ManagementError } from "../src/domain/errors.ts";
import { LocalFileSystemError } from "../src/domain/local-file-system.ts";
import {
	backendMessage,
	formatBackendMessage,
	resolveBackendLocale,
	validateBackendMessageCatalogs,
	validateBackendMessageDescriptor,
} from "../src/i18n/message.ts";
import { localizePublicValue } from "../src/i18n/projection.ts";
import { descriptorForPublicCode, descriptorForPublicFailure, normalizePublicError } from "../src/i18n/public-error.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("SSH Agent backend i18n", () => {
	it("keeps catalogs and placeholders aligned", () => {
		expect(validateBackendMessageCatalogs()).toEqual([]);
		expect(
			validateBackendMessageDescriptor(backendMessage("approval.remote_file_overwrite", { path: "/srv/app.jar" })),
		).toEqual({ valid: true, errors: [] });
		expect(validateBackendMessageDescriptor(backendMessage("approval.remote_file_overwrite"))).toEqual({
			valid: false,
			errors: ["missing path"],
		});
	});

	it("normalizes locale input and defaults to Chinese", () => {
		expect(resolveBackendLocale({})).toBe("zh-CN");
		expect(resolveBackendLocale({ acceptLanguage: "zh-Hans;q=0.8,en-US;q=0.5" })).toBe("zh-CN");
		expect(resolveBackendLocale({ acceptLanguage: "fr-FR" })).toBe("en-US");
		expect(resolveBackendLocale({ locale: "zh-Hant" })).toBe("en-US");
		expect(resolveBackendLocale({ locale: "fr-FR", acceptLanguage: "zh-CN" })).toBe("en-US");
		expect(resolveBackendLocale({ locale: "en", acceptLanguage: "zh-CN" })).toBe("en-US");
	});

	it("normalizes known errors and hides unknown errors behind an error id", () => {
		const known = normalizePublicError(new ManagementError("validation_error", "raw validation", "name"));
		expect(known).toMatchObject({ code: "validation_error", status: 400, field: "name" });
		expect(formatBackendMessage("zh-CN", known.message)).toBe("字段 name 的值无效");

		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const unknown = normalizePublicError(new Error("database password leaked"));
		expect(unknown).toMatchObject({
			code: "internal_error",
			status: 500,
			message: { key: "common.internal_error" },
			details: { errorId: expect.any(String) },
		});
		consoleError.mockRestore();
	});

	it("maps SSH failure codes to the SSH message catalog", () => {
		const descriptor = descriptorForPublicCode("connection_timeout");
		expect(descriptor).toEqual({ key: "ssh.connection_timeout" });
		expect(formatBackendMessage("zh-CN", descriptor!)).toBe("SSH 连接超时");
	});

	it("keeps shared failure codes scoped to their domain", () => {
		const local = normalizePublicError(new LocalFileSystemError("session_not_found", "fallback", 404));
		expect(formatBackendMessage("zh-CN", local.message)).toBe("未找到 Session");
		expect(descriptorForPublicCode("session_not_found")).toEqual({ key: "ssh.session_not_found" });
	});

	it("localizes Guard framing without translating the user-defined reason", () => {
		const descriptor = descriptorForPublicFailure("guard_blocked", "生产环境禁止执行");
		expect(formatBackendMessage("en-US", descriptor!)).toBe(
			"Workspace Guard blocked the command. Reason: 生产环境禁止执行",
		);
		expect(formatBackendMessage("zh-CN", descriptor!)).toBe("Workspace Guard 已阻止该命令。原因：生产环境禁止执行");
	});

	it("localizes only explicit backend presentation metadata", () => {
		const source = {
			approval: {
				description: "Remote file overwrite confirmation",
				descriptionMessageKey: "approval.remote_file_overwrite",
				descriptionValues: { path: "/srv/releases/app.tar" },
			},
			message: { role: "assistant", content: [{ type: "text", text: "用户或模型动态内容" }] },
		};
		expect(localizePublicValue(source, "zh-CN")).toEqual({
			approval: { description: "远程文件 /srv/releases/app.tar 已存在。继续执行将覆盖该文件，是否继续执行？" },
			message: source.message,
		});
		expect(source.approval).toHaveProperty("descriptionMessageKey");
	});

	it("hides Provider failure diagnostics in the browser projection", () => {
		const source = {
			role: "assistant",
			stopReason: "error",
			errorMessage: "provider response included a secret",
			diagnostics: [{ details: { body: "upstream secret body" } }],
		};
		expect(localizePublicValue(source, "zh-CN")).toEqual({
			role: "assistant",
			stopReason: "error",
			errorMessage: "Chat Run 执行失败",
		});
		expect(source.diagnostics).toHaveLength(1);
	});

	it("projects persisted and connection failures from stable codes", () => {
		const source = {
			connection: { lastError: { code: "connection_timeout", message: "raw SSH transport error" } },
			transfer: {
				failure: {
					code: "transfer_cancelled",
					message: "File transfer was cancelled",
					messageKey: "sftp.transfer_cancelled",
					retryable: false,
				},
			},
		};
		expect(localizePublicValue(source, "zh-CN")).toEqual({
			connection: { lastError: { code: "connection_timeout", message: "SSH 连接超时" } },
			transfer: {
				failure: { code: "transfer_cancelled", message: "文件传输已取消", retryable: false },
			},
		});
	});

	it("localizes cached Chat events independently for each subscriber and replay", async () => {
		const stream = new ChatRunEventStream("run-1");
		stream.publish("approval.requested", {
			description: "fallback",
			descriptionMessageKey: "approval.local_file_overwrite",
			descriptionValues: { path: "/tmp/app.tar" },
		});
		stream.publish("tool_execution_update", {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "sftp_upload",
			update: {
				type: "progress",
				detail: {
					current: 1,
					total: 2,
					unit: "bytes",
					message: "Uploading /srv/app.tar",
					messageDescriptor: { key: "sftp.upload_running", values: { path: "/srv/app.tar" } },
				},
			},
		});
		const chinese = stream.subscribe(0, "zh-CN").getReader();
		const english = stream.subscribe(0, "en-US").getReader();
		await chinese.read();
		await english.read();
		expect(decode((await chinese.read()).value)).toContain("本地文件 /tmp/app.tar 已存在");
		expect(decode((await english.read()).value)).toContain("Local file /tmp/app.tar already exists");
		const chineseUpdate = decode((await chinese.read()).value);
		const englishUpdate = decode((await english.read()).value);
		expect(chineseUpdate).toContain('"message":"正在上传 /srv/app.tar"');
		expect(englishUpdate).toContain('"message":"Uploading /srv/app.tar"');
		expect(chineseUpdate).not.toContain("messageDescriptor");
		stream.close();
	});

	it("localizes Workspace events independently for each subscriber", async () => {
		const events = new WorkspaceEventHub();
		const topics = new Set(["monitoring"] as const);
		const chinese = events.subscribe("workspace-1", topics, "zh-CN").getReader();
		const english = events.subscribe("workspace-1", topics, "en-US").getReader();
		await chinese.read();
		await english.read();
		events.publish("workspace-1", {
			type: "monitor.error",
			data: {
				sampledAt: 1,
				code: "monitor_probe_failed",
				message: "Remote metrics collection failed",
				messageKey: "monitor.probe_failed",
			},
		});
		expect(decode((await chinese.read()).value)).toContain('"message":"远程指标采集失败"');
		expect(decode((await english.read()).value)).toContain('"message":"Remote metrics collection failed"');
		events.close();
	});

	it("negotiates REST messages without changing the response contract", async () => {
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: new Uint8Array(32).fill(8),
			clock: { now: () => 1_000 },
			llmModelsFactory: createTestLlmModels,
		});
		try {
			const chinese = await backend.handleRequest(
				new Request("http://localhost/api/not-present", { headers: { "accept-language": "zh-CN" } }),
			);
			expect(chinese.status).toBe(404);
			expect(chinese.headers.get("content-language")).toBe("zh-CN");
			expect(chinese.headers.get("vary")).toContain("Accept-Language");
			expect(await chinese.json()).toEqual({ error: { code: "not_found", message: "未找到 API 接口" } });

			const english = await backend.handleRequest(
				new Request("http://localhost/api/not-present", {
					headers: { "accept-language": "en-US" },
				}),
			);
			expect(english.headers.get("content-language")).toBe("en-US");
			expect(english.headers.get("vary")).toContain("Accept-Language");
			expect(await english.json()).toEqual({
				error: { code: "not_found", message: "API endpoint not found" },
			});

			const restQueryLocale = await backend.handleRequest(
				new Request("http://localhost/api/not-present?locale=en-US", {
					headers: { "accept-language": "zh-CN" },
				}),
			);
			expect(restQueryLocale.headers.get("content-language")).toBe("zh-CN");
			expect(restQueryLocale.headers.get("vary")).toContain("Accept-Language");

			const sse = await backend.handleRequest(
				new Request("http://localhost/api/workspaces/workspace-i18n/events?topics=monitoring&locale=en-US"),
			);
			expect(sse.headers.get("content-language")).toBe("en-US");
			expect(sse.headers.get("vary")).toBeNull();
			await sse.body?.cancel();

			const approvalColumns = backend.database.prepare("PRAGMA table_info(chat_tool_approvals)").all();
			const terminalColumns = backend.database.prepare("PRAGMA table_info(terminal_sessions)").all();
			expect(approvalColumns).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "description_message_key" }),
					expect.objectContaining({ name: "description_values_json" }),
				]),
			);
			expect(terminalColumns).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "failure_message_key" }),
					expect.objectContaining({ name: "failure_message_values_json" }),
				]),
			);
			backend.database.exec("PRAGMA foreign_keys = OFF");
			const chats = new SqliteChatRepository(backend.database);
			chats.insertApproval({
				id: "approval-i18n",
				sessionId: "session-i18n",
				runId: "run-i18n",
				assistantMessageId: "assistant-i18n",
				toolCallId: "tool-i18n",
				toolName: "sftp_upload",
				description: "Remote file fallback",
				descriptionMessageKey: "approval.remote_file_overwrite",
				descriptionValues: { path: "/srv/app.tar" },
				status: "pending",
				createdAt: 1,
			});
			expect(chats.findApproval("session-i18n", "approval-i18n")).toMatchObject({
				descriptionMessageKey: "approval.remote_file_overwrite",
				descriptionValues: { path: "/srv/app.tar" },
			});
			const terminals = new SqliteTerminalRepository(backend.database);
			terminals.insertSession({
				id: "terminal-i18n",
				sessionId: "session-i18n",
				workspaceId: "workspace-i18n",
				openRequestId: "open-i18n",
				closeRequestId: null,
				status: "failed",
				revision: 1,
				geometry: { rows: 24, cols: 80 },
				eventSequence: 0,
				ownershipEpoch: 0,
				connectionGeneration: null,
				term: "xterm-256color",
				activatedAt: null,
				lastConsumerActivityAt: 1,
				idleDeadlineAt: null,
				closingAt: null,
				closedAt: 1,
				closeReason: "open_failed",
				failureCode: "terminal_open_failed",
				failureMessage: "Terminal open fallback",
				createdAt: 1,
				updatedAt: 1,
			});
			expect(terminals.findSession("terminal-i18n")).toMatchObject({
				failureMessageKey: "terminal.open_failed",
			});

			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
			vi.spyOn(backend.api, "getWorkspaceSessionTree").mockRejectedValueOnce(
				new Error("sqlite connection included a secret"),
			);
			const internal = await backend.handleRequest(
				new Request("http://localhost/api/workspace-session-tree", {
					headers: { "accept-language": "en-US" },
				}),
			);
			const internalBody = (await internal.json()) as {
				error: { code: string; message: string; details: { errorId: string } };
			};
			expect(internal.status).toBe(500);
			expect(internalBody.error).toMatchObject({
				code: "internal_error",
				message: "Internal server error",
				details: { errorId: expect.any(String) },
			});
			expect(JSON.stringify(internalBody)).not.toContain("sqlite connection included a secret");
			consoleError.mockRestore();
		} finally {
			await backend.close();
		}
	});

	it("adds persisted message metadata without replacing historical fallbacks", () => {
		const database = new DatabaseSync(":memory:");
		try {
			applyMigrations(database);
			database.exec("PRAGMA foreign_keys = OFF");
			database
				.prepare(
					"INSERT INTO chat_tool_approvals (id, session_id, run_id, assistant_message_id, tool_call_id, tool_name, description, status, source, rejection_reason, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)",
				)
				.run(
					"approval-old",
					"session-old",
					"run-old",
					"assistant-old",
					"tool-old",
					"sftp_upload",
					"historical fallback",
					"pending",
					1,
				);
			database.exec(`
				ALTER TABLE chat_tool_approvals DROP COLUMN description_message_key;
				ALTER TABLE chat_tool_approvals DROP COLUMN description_values_json;
				ALTER TABLE terminal_sessions DROP COLUMN failure_message_key;
				ALTER TABLE terminal_sessions DROP COLUMN failure_message_values_json;
				DELETE FROM ssh_agent_schema_migrations WHERE version = 13;
			`);

			applyMigrations(database);

			expect(
				database
					.prepare(
						"SELECT description, description_message_key, description_values_json FROM chat_tool_approvals WHERE id = ?",
					)
					.get("approval-old"),
			).toEqual({
				description: "historical fallback",
				description_message_key: null,
				description_values_json: null,
			});
		} finally {
			database.close();
		}
	});
});

function decode(value: Uint8Array | undefined): string {
	return new TextDecoder().decode(value);
}
