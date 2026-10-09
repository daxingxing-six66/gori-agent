import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapRemoteCommand } from "../src/infrastructure/sandbox/shell-command.ts";
import { DefaultCommandGuardEvaluator } from "../src/application/services/command-guard-evaluator.ts";
import { COMMAND_EXECUTION_DEFAULTS, CommandOperationService } from "../src/application/services/command-operation-service.ts";
import type { RemoteSandboxProvider } from "../src/application/services/remote-sandbox-provider.ts";
import { DefaultSshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import type {
	ExecuteRemoteCommandInput,
	RemoteExecutionResult,
	RemoteUploadResult,
	SshChannelBroker,
	UploadRemoteFileInput,
} from "../src/application/ssh-channel-broker.ts";
import { createRemoteServerCallTool } from "../src/application/tools/remote-server-call-tool.ts";
import type { IdGenerator } from "../src/domain/ids.ts";
import { SqliteCommandOperationRepository } from "../src/infrastructure/sqlite/sqlite-command-operation-repository.ts";
import { SqliteCredentialRepository } from "../src/infrastructure/sqlite/sqlite-credential-repository.ts";
import { SqliteGuardRepository } from "../src/infrastructure/sqlite/sqlite-guard-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteWorkspaceRepository } from "../src/infrastructure/sqlite/sqlite-workspace-repository.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

const directories: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class SequentialIds implements IdGenerator {
	private value = 1;

	next(): string {
		const id = `id-${this.value}`;
		this.value += 1;
		return id;
	}
}

class FakeBroker implements Pick<SshChannelBroker, "execute"> {
	readonly commands: string[] = [];
	private readonly releases: Array<() => void> = [];
	blockFirst = false;
	blockAll = false;
	active = 0;
	maxActive = 0;

	async execute(input: ExecuteRemoteCommandInput): Promise<RemoteExecutionResult> {
		const commandNumber = this.commands.length + 1;
		this.commands.push(input.command);
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this.blockAll || (this.blockFirst && commandNumber === 1)) {
				await new Promise<void>((resolve) => {
					this.releases.push(resolve);
				});
			}
			await input.onStdout(new TextEncoder().encode(`output-${commandNumber}`));
			return { exitCode: 0 };
		} finally {
			this.active -= 1;
		}
	}

	async upload(_input: UploadRemoteFileInput): Promise<RemoteUploadResult> {
		throw new Error("File upload is not used by command Operation tests");
	}

	releaseFirst(): void {
		this.releases.shift()?.();
	}

	releaseAll(): void {
		for (const release of this.releases.splice(0)) release();
	}

	invalidateWorkspace(): void {}
	invalidateCredential(): void {}
	close(): void {}
}

describe("SSH command Operation execution", () => {
	it("dispatches commands serially within one Session", async () => {
		const fixture = await createFixture();
		fixture.broker.blockFirst = true;
		try {
			const first = fixture.service.submit({ toolCallId: "tool-1", sessionId: "id-4", command: "echo first" });
			await waitFor(() => fixture.broker.commands.length === 1);
			const second = fixture.service.submit({ toolCallId: "tool-2", sessionId: "id-4", command: "echo second" });
			await Promise.resolve();
			expect(fixture.broker.commands).toHaveLength(1);
			fixture.broker.releaseFirst();
			const [firstResult, secondResult] = await Promise.all([first, second]);
			expect(firstResult.operation.status).toBe("completed");
			expect(secondResult.operation.status).toBe("completed");
			expect(fixture.broker.commands).toEqual([wrapRemoteCommand("/srv/app", "echo first"), wrapRemoteCommand("/srv/app", "echo second")]);
			expect(firstResult.outputTail).toBe("output-1");
			expect(secondResult.outputTail).toBe("output-2");
		} finally {
			await fixture.close();
		}
	});

	it("runs commands from different Sessions concurrently", async () => {
		const fixture = await createFixture();
		fixture.broker.blockFirst = true;
		try {
			const secondSessionId = await createSession(fixture.backend, "Concurrent Session", fixture.workDir);
			const first = fixture.service.submit({ toolCallId: "tool-a", sessionId: "id-4", command: "sleep 10" });
			await waitFor(() => fixture.broker.commands.length === 1);
			const second = fixture.service.submit({
				toolCallId: "tool-b",
				sessionId: secondSessionId,
				command: "echo ready",
			});
			await waitFor(() => fixture.broker.commands.length === 2);
			expect(await second).toMatchObject({ operation: { status: "completed" } });
			fixture.broker.releaseFirst();
			await first;
			expect(fixture.broker.maxActive).toBe(2);
		} finally {
			await fixture.close();
		}
	});

	it("limits concurrent Operations across Sessions", async () => {
		const fixture = await createFixture({ maxConcurrentOperations: 2 });
		fixture.broker.blockAll = true;
		try {
			const secondSessionId = await createSession(fixture.backend, "Second Session", fixture.workDir);
			const thirdSessionId = await createSession(fixture.backend, "Third Session", fixture.workDir);
			const first = fixture.service.submit({ toolCallId: "tool-limit-a", sessionId: "id-4", command: "sleep 1" });
			const second = fixture.service.submit({
				toolCallId: "tool-limit-b",
				sessionId: secondSessionId,
				command: "sleep 2",
			});
			const third = fixture.service.submit({
				toolCallId: "tool-limit-c",
				sessionId: thirdSessionId,
				command: "sleep 3",
			});
			await waitFor(() => fixture.broker.commands.length === 2);
			await Promise.resolve();
			expect(fixture.broker.commands).toHaveLength(2);
			const queued = fixture.backend.database
				.prepare("SELECT status FROM command_operations WHERE tool_call_id = ?")
				.get("tool-limit-c");
			expect(queued?.status).toBe("queued");
			fixture.broker.releaseFirst();
			await waitFor(() => fixture.broker.commands.length === 3);
			expect(fixture.broker.maxActive).toBe(2);
			fixture.broker.releaseAll();
			await Promise.all([first, second, third]);
		} finally {
			await fixture.close();
		}
	});

	it("actively cancels a command waiting behind the same Session", async () => {
		const fixture = await createFixture();
		fixture.broker.blockFirst = true;
		try {
			const first = fixture.service.submit({ toolCallId: "tool-cancel-a", sessionId: "id-4", command: "sleep 10" });
			await waitFor(() => fixture.broker.commands.length === 1);
			const controller = new AbortController();
			const second = fixture.service.submit({
				toolCallId: "tool-cancel-b",
				sessionId: "id-4",
				command: "echo never",
				signal: controller.signal,
			});
			controller.abort();
			await expect(second).resolves.toMatchObject({
				operation: { status: "cancelled", failure: { code: "cancelled_before_dispatch" } },
			});
			expect(fixture.broker.commands).toHaveLength(1);
			fixture.broker.releaseFirst();
			await first;
			expect(fixture.broker.commands).toHaveLength(1);
		} finally {
			await fixture.close();
		}
	});

	it("actively expires and persists a command waiting behind the same Session", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
		const fixture = await createFixture();
		fixture.broker.blockFirst = true;
		try {
			const first = fixture.service.submit({ toolCallId: "tool-timeout-a", sessionId: "id-4", command: "sleep 10" });
			await flushMicrotasksUntil(() => fixture.broker.commands.length === 1);
			const second = fixture.service.submit({
				toolCallId: "tool-timeout-b",
				sessionId: "id-4",
				command: "echo never",
			});
			await vi.advanceTimersByTimeAsync(60_000);
			await expect(second).resolves.toMatchObject({
				operation: { status: "cancelled", failure: { code: "queue_timeout" } },
			});
			const persisted = fixture.backend.database
				.prepare("SELECT status, failure_json FROM command_operations WHERE tool_call_id = ?")
				.get("tool-timeout-b");
			expect(persisted?.status).toBe("cancelled");
			expect(persisted?.failure_json).toContain('"code":"queue_timeout"');
			expect(fixture.broker.commands).toHaveLength(1);
			fixture.broker.releaseFirst();
			await first;
		} finally {
			await fixture.close();
			vi.useRealTimers();
		}
	});

	it("checks Guard at consume time and exposes a terminating structured Tool failure", async () => {
		const fixture = await createFixture();
		try {
			const guard = await request(fixture.backend.handleRequest, "GET", "/api/workspaces/id-1/guard");
			await request(fixture.backend.handleRequest, "PATCH", "/api/workspaces/id-1/guard", {
				enabled: true,
				expectedRevision: guard.revision,
				rules: [
					{
						displayName: "No destructive deletes",
						pattern: "rm -rf",
						match: "contains",
						reason: "Destructive delete is not allowed",
						enabled: true,
					},
				],
			});
			let aborted = false;
			const tool = createRemoteServerCallTool({
				sessionId: "id-4",
				operations: fixture.service,
				abortRun: () => {
					aborted = true;
				},
			});
			await expect(tool.execute("tool-guard", { command: "rm -rf /tmp/example" })).rejects.toMatchObject({
				name: "AgentToolError",
				terminate: true,
				details: { status: "blocked", failure: { code: "guard_blocked" } },
			});
			expect(aborted).toBe(true);
			expect(fixture.broker.commands).toEqual([]);
			const row = fixture.backend.database
				.prepare("SELECT status, matched_guard_rule_id FROM command_operations WHERE tool_call_id = ?")
				.get("tool-guard");
			expect(row?.status).toBe("blocked");
			expect(row?.matched_guard_rule_id).toBeTruthy();
		} finally {
			await fixture.close();
		}
	});

	it("returns only a final Tool result without forwarding internal Operation events", async () => {
		const fixture = await createFixture();
		try {
			const tool = createRemoteServerCallTool({ sessionId: "id-4", operations: fixture.service });
			const onUpdate = vi.fn();
			await expect(
				tool.execute("tool-final-only", { command: "echo ready" }, undefined, onUpdate),
			).resolves.toMatchObject({
				content: [{ type: "text", text: "output-1" }],
				details: { status: "completed", exitCode: 0 },
			});
			expect(onUpdate).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	});

	it("returns remote command failures with output and terminate=false for model recovery", async () => {
		const fixture = await createFixture();
		try {
			vi.spyOn(fixture.broker, "execute").mockImplementationOnce(async (input) => {
				await input.onStdout(new TextEncoder().encode("partial output\n"));
				await input.onStderr(new TextEncoder().encode("command not found\n"));
				return { exitCode: 127 };
			});
			const abortRun = vi.fn();
			const tool = createRemoteServerCallTool({ sessionId: "id-4", operations: fixture.service, abortRun });
			await expect(tool.execute("tool-failed", { command: "missing-command" })).rejects.toMatchObject({
				name: "AgentToolError", terminate: false,
				content: [{ type: "text", text: expect.stringContaining("partial output\ncommand not found") }],
				details: { status: "failed", exitCode: 127, failure: { code: "remote_exit_non_zero" } },
			});
			expect(abortRun).not.toHaveBeenCalled();
			const row = fixture.backend.database.prepare("SELECT status, failure_json FROM command_operations WHERE tool_call_id = ?")
				.get("tool-failed");
			expect(row?.status).toBe("failed");
			expect(row?.failure_json).toContain('"code":"remote_exit_non_zero"');
		} finally {
			await fixture.close();
		}
	});

	it("keeps checks, persisted dispatch state and execution in order", async () => {
		const fixture = await createFixture();
		try {
			const steps: string[] = [];
			vi.spyOn(fixture.guards, "evaluate").mockImplementation(async () => {
				steps.push("guard");
				return { allowed: true, guardRevision: 9 };
			});
			const prepare = fixture.sandbox.prepare.bind(fixture.sandbox);
			vi.spyOn(fixture.sandbox, "prepare").mockImplementation(async (input) => {
				steps.push("prepare");
				return prepare(input);
			});
			vi.spyOn(fixture.broker, "execute").mockImplementationOnce(async () => {
				steps.push("execute");
				const row = fixture.backend.database.prepare("SELECT id FROM command_operations WHERE tool_call_id = ?")
					.get("ordered");
				expect(await fixture.operations.findById(String(row?.id))).toMatchObject({
					status: "running", guardRevision: 9, resolvedCwd: "/srv/app",
					sandbox: { enforcement: "none", commandMayHaveRun: true },
				});
				return { exitCode: 0 };
			});
			const result = await fixture.service.submit({ toolCallId: "ordered", sessionId: "id-4", command: "echo x",
				onEvent: (event) => { if (event.type === "status" && "status" in event.data) steps.push(event.data.status); } });
			expect(steps).toEqual(["created", "queued", "dispatching", "guard", "prepare", "guard", "running", "execute", "completed"]);
			expect(await fixture.operations.findById(result.operation.id)).toMatchObject({ status: "completed", exitCode: 0 });
		} finally { await fixture.close(); }
	});

	it.each([1, 2])("persists the same Guard failure at check %s even if abortRun throws", async (blockedCheck) => {
		const fixture = await createFixture();
		try {
			let checks = 0;
			const rule = { id: "blocked-rule", displayName: "Blocked", pattern: "echo", match: "contains" as const,
				reason: "Rule changed", enabled: true, source: "user" as const, level: "strict" as const };
			vi.spyOn(fixture.guards, "evaluate").mockImplementation(async () => {
				checks += 1;
				return { allowed: checks !== blockedCheck, guardRevision: checks, matchedRule: checks === blockedCheck ? rule : undefined };
			});
			const prepare = vi.spyOn(fixture.sandbox, "prepare");
			const execute = vi.spyOn(fixture.broker, "execute");
			const abortRun = vi.fn(() => { throw new Error("Callback failed"); });
			const result = await fixture.service.submit({ toolCallId: "blocked", sessionId: "id-4", command: "echo x", abortRun });
			expect(result.operation).toMatchObject({ status: "blocked", guardRevision: blockedCheck,
				matchedGuardRuleId: rule.id, failure: { code: "guard_blocked", message: rule.reason, safeDetails: { ruleId: rule.id } },
				sandbox: { commandMayHaveRun: false } });
			expect(await fixture.operations.findById(result.operation.id)).toMatchObject(result.operation);
			expect(abortRun).toHaveBeenCalledOnce();
			expect(prepare).toHaveBeenCalledTimes(blockedCheck - 1);
			expect(execute).not.toHaveBeenCalled();
		} finally { await fixture.close(); }
	});

	it.each(["cancel", "deadline"] as const)("rejects %s occurring while the queued Operation is being loaded", async (change) => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		try {
			const controller = new AbortController();
			const find = fixture.operations.findById.bind(fixture.operations);
			vi.spyOn(fixture.operations, "findById").mockImplementationOnce(async (id) => {
				const operation = await find(id);
				if (!operation) throw new Error("Queued Operation is missing");
				if (change === "cancel") controller.abort();
				else vi.setSystemTime(operation.queueDeadlineAt);
				return operation;
			});
			const guard = vi.spyOn(fixture.guards, "evaluate");
			const result = await fixture.service.submit({ toolCallId: "load-race", sessionId: "id-4", command: "echo x", signal: controller.signal });
			expect(result.operation).toMatchObject({ status: "cancelled",
				failure: { code: change === "cancel" ? "cancelled_before_dispatch" : "queue_timeout" },
				sandbox: { commandMayHaveRun: false } });
			expect(await fixture.operations.findById(result.operation.id)).toMatchObject(result.operation);
			expect(guard).not.toHaveBeenCalled();
			expect(fixture.broker.commands).toEqual([]);
		} finally { await fixture.close(); }
	});

	it("does not dispatch after a failed running-state write and releases the scheduler permit", async () => {
		const fixture = await createFixture({ maxConcurrentOperations: 1 });
		try {
			const update = fixture.operations.update.bind(fixture.operations);
			const persistence = vi.spyOn(fixture.operations, "update").mockImplementation((operation, expected) =>
				operation.status === "running" ? Promise.resolve(false) : update(operation, expected));
			await expect(fixture.service.submit({ toolCallId: "persist-failure", sessionId: "id-4", command: "echo x" }))
				.rejects.toMatchObject({ failure: { code: "operation_persistence_failed" } });
			expect(fixture.broker.commands).toEqual([]);
			const row = fixture.backend.database.prepare("SELECT status FROM command_operations WHERE tool_call_id = ?")
				.get("persist-failure");
			expect(row?.status).toBe("dispatching");
			persistence.mockRestore();
			await expect(fixture.service.submit({ toolCallId: "after-failure", sessionId: "id-4", command: "echo next" }))
				.resolves.toMatchObject({ operation: { status: "completed" } });
		} finally { await fixture.close(); }
	});

	it.each([
		[{ exitSignal: "SIGTERM" }, "failed", "exit_signal_received"],
		[{}, "uncertain", "execution_result_uncertain"],
	] as const)("persists terminal status for remote result %j", async (remoteResult, status, code) => {
		const fixture = await createFixture();
		try {
			vi.spyOn(fixture.broker, "execute").mockResolvedValueOnce(remoteResult);
			const result = await fixture.service.submit({ toolCallId: "exit-result", sessionId: "id-4", command: "echo x" });
			expect(result.operation).toMatchObject({ status, failure: { code }, sandbox: { commandMayHaveRun: true } });
			expect(await fixture.operations.findById(result.operation.id)).toMatchObject({
				status, failure: result.operation.failure, sandbox: result.operation.sandbox, ...remoteResult,
			});
		} finally { await fixture.close(); }
	});

	it("limits persisted output, emits truncation once and retains the final model tail", async () => {
		const fixture = await createFixture();
		try {
			const limit = COMMAND_EXECUTION_DEFAULTS.persistedOutputLimitBytes;
			vi.spyOn(fixture.broker, "execute").mockImplementationOnce(async (input) => {
				await input.onStdout(Buffer.alloc(limit - 3, "a"));
				await input.onStdout(Buffer.alloc(80_000, "b"));
				await input.onStderr(Buffer.from("END"));
				return { exitCode: 0 };
			});
			const result = await fixture.service.submit({ toolCallId: "output-limit", sessionId: "id-4", command: "echo x" });
			expect(result.operation).toMatchObject({ status: "completed", outputBytes: limit + 80_000, outputTruncated: true });
			expect(result.outputTail).toBe("b".repeat(COMMAND_EXECUTION_DEFAULTS.llmOutputTailBytes - 3) + "END");
			const events = await fixture.operations.listEvents(result.operation.id);
			expect(events.filter((event) => event.type === "output_truncated")).toHaveLength(1);
			const persistedOutput = events.reduce((length, event) => length + ("chunk" in event.data ? Buffer.byteLength(event.data.chunk) : 0), 0);
			expect(persistedOutput).toBe(limit);
		} finally { await fixture.close(); }
	});

	it("times out sandbox preparation before dispatch and clears execution resources", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		try {
			const timersBefore = vi.getTimerCount();
			let started = false;
			vi.spyOn(fixture.sandbox, "prepare").mockImplementation(({ signal }) => {
				started = true;
				return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
			});
			const pending = fixture.service.submit({ toolCallId: "prepare-timeout", sessionId: "id-4", command: "echo x", timeoutMs: 25 });
			await flushMicrotasksUntil(() => started);
			await vi.advanceTimersByTimeAsync(25);
			expect((await pending).operation).toMatchObject({ status: "failed", failure: { code: "execution_timeout" }, sandbox: { commandMayHaveRun: false } });
			expect(fixture.broker.commands).toEqual([]);
			expect(vi.getTimerCount()).toBe(timersBefore);
		} finally { await fixture.close(); }
	});

	it("prevents deleting a Session while its command is active", async () => {
		const fixture = await createFixture();
		fixture.broker.blockFirst = true;
		try {
			const running = fixture.service.submit({ toolCallId: "tool-running", sessionId: "id-4", command: "sleep 10" });
			await waitFor(() => fixture.broker.commands.length === 1);
			const response = await rawRequest(
				fixture.backend.handleRequest,
				"DELETE",
				"/api/sessions/id-4?expectedRevision=1",
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ error: { code: "session_has_active_operations" } });
			fixture.broker.releaseFirst();
			await running;
		} finally {
			await fixture.close();
		}
	});

	it("marks an Operation left running by a previous process as uncertain", async () => {
		const fixture = await createFixture();
		try {
			const repository = new SqliteCommandOperationRepository(fixture.backend.database);
			await repository.insert({
				id: "orphan-running",
				toolCallId: "old-tool",
				sessionId: "id-4",
				workspaceId: "id-1",
				command: "deploy",
				timeoutMs: 300_000,
				status: "running",
				queueDeadlineAt: Date.now() + 60_000,
				outputBytes: 0,
				outputTruncated: false,
				createdAt: Date.now(),
				startedAt: Date.now(),
			});
			const sessions = new SqliteSessionRepository(fixture.backend.database);
			const restarted = new CommandOperationService({
				operations: repository,
				sessions,
				targets: new DefaultSshTargetResolver({
					sessions,
					workspaces: new SqliteWorkspaceRepository(fixture.backend.database),
					credentials: new SqliteCredentialRepository(fixture.backend.database),
					hostTrust: staticHostTrust,
				}),
				guards: new DefaultCommandGuardEvaluator(new SqliteGuardRepository(fixture.backend.database)),
				broker: fixture.broker,
				clock: { now: () => Date.now() },
				ids: new SequentialIds(),
			});
			try {
				await restarted.submit({ toolCallId: "new-tool", sessionId: "id-4", command: "true" });
				const recovered = await repository.findById("orphan-running");
				expect(recovered).toMatchObject({
					status: "uncertain",
					failure: { code: "execution_result_uncertain", retryable: false },
				});
			} finally {
				restarted.close();
			}
		} finally {
			await fixture.close();
		}
	});
});

async function createFixture(options: { maxConcurrentOperations?: number } = {}): Promise<{
	backend: ReturnType<typeof createSqliteManagementBackend>;
	broker: FakeBroker;
	service: CommandOperationService;
	operations: SqliteCommandOperationRepository;
	guards: DefaultCommandGuardEvaluator;
	sandbox: RemoteSandboxProvider;
	workDir: string;
	close(): Promise<void>;
}> {
	const workDir = realpathSync(mkdtempSync(join(tmpdir(), "command-operation-")));
	directories.push(workDir);
	const ids = new SequentialIds();
	const backend = createSqliteManagementBackend({
		databasePath: ":memory:",
		localCwd: workDir,
		credentialEncryptionKey: new Uint8Array(32).fill(7),
		clock: { now: () => Date.now() },
		ids,
		llmModelsFactory: createTestLlmModels,
	});
	await request(backend.handleRequest, "POST", "/api/workspaces", {
		displayName: "Production",
		environment: "production",
		host: {
			hostname: "server.example.com",
			port: 22,
		},
		credential: { displayName: "root", remoteUser: "root", type: "password", password: "secret" },
		defaultCwd: workDir,
		remoteDefaultCwd: "/srv/app",
		connection: { connectTimeoutMs: 10_000 },
	});
	await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", { displayName: "Session", workDir });
	const broker = new FakeBroker();
	const operations = new SqliteCommandOperationRepository(backend.database);
	const sessions = new SqliteSessionRepository(backend.database);
	const guards = new DefaultCommandGuardEvaluator(new SqliteGuardRepository(backend.database));
	const sandbox: RemoteSandboxProvider = {
		prepareTerminal: async () => { throw new Error("Unexpected Terminal preparation"); },
		prepare: async ({ cwd, command, target }) => ({ command: wrapRemoteCommand(cwd, command),
			sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5,
				launcherVersion: "3", sandboxRoot: target.defaultCwd } }),
	};
	const service = new CommandOperationService({
		operations,
		sessions,
		targets: new DefaultSshTargetResolver({
			sessions,
			workspaces: new SqliteWorkspaceRepository(backend.database),
			credentials: new SqliteCredentialRepository(backend.database),
			hostTrust: staticHostTrust,
		}),
		guards,
		broker,
		sandbox,
		clock: { now: () => Date.now() },
		ids,
		...(options.maxConcurrentOperations === undefined
			? {}
			: { maxConcurrentOperations: options.maxConcurrentOperations }),
	});
	return {
		backend,
		broker,
		service,
		operations,
		guards,
		sandbox,
		workDir,
		close: async () => {
			service.close();
			await backend.close();
		},
	};
}

const staticHostTrust = {
	ensureTrusted: async () => ({ algorithm: "ssh-ed25519", fingerprint: "SHA256:test", verifiedAt: 1 }),
};

async function createSession(
	backend: ReturnType<typeof createSqliteManagementBackend>,
	displayName: string,
	workDir: string,
): Promise<string> {
	const response = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", { displayName, workDir });
	if (typeof response.id !== "string") throw new Error("Session response did not contain an id");
	return response.id;
}

async function request(
	handler: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const response = await rawRequest(handler, method, path, body);
	expect(response.status).toBeLessThan(400);
	return (await response.json()) as Record<string, unknown>;
}

function rawRequest(
	handler: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	return handler(
		new Request(`http://localhost${path}`, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		}),
	);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Condition was not reached");
}

async function flushMicrotasksUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("Condition was not reached while flushing microtasks");
}
