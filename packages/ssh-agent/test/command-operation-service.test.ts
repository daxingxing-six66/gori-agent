import { describe, expect, it, vi } from "vitest";
import { DefaultCommandGuardEvaluator } from "../src/application/services/command-guard-evaluator.ts";
import { CommandOperationService } from "../src/application/services/command-operation-service.ts";
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
			expect(fixture.broker.commands).toEqual(["cd -- '/srv/app' && echo first", "cd -- '/srv/app' && echo second"]);
			expect(firstResult.outputTail).toBe("output-1");
			expect(secondResult.outputTail).toBe("output-2");
		} finally {
			fixture.close();
		}
	});

	it("runs commands from different Sessions concurrently", async () => {
		const fixture = await createFixture();
		fixture.broker.blockFirst = true;
		try {
			const secondSessionId = await createSession(fixture.backend, "Concurrent Session");
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
			fixture.close();
		}
	});

	it("limits concurrent Operations across Sessions", async () => {
		const fixture = await createFixture({ maxConcurrentOperations: 2 });
		fixture.broker.blockAll = true;
		try {
			const secondSessionId = await createSession(fixture.backend, "Second Session");
			const thirdSessionId = await createSession(fixture.backend, "Third Session");
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
			fixture.close();
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
			fixture.close();
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
			fixture.close();
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
			fixture.close();
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
			fixture.close();
		}
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
			fixture.close();
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
			fixture.close();
		}
	});
});

async function createFixture(options: { maxConcurrentOperations?: number } = {}): Promise<{
	backend: ReturnType<typeof createSqliteManagementBackend>;
	broker: FakeBroker;
	service: CommandOperationService;
	close(): void;
}> {
	const ids = new SequentialIds();
	const backend = createSqliteManagementBackend({
		databasePath: ":memory:",
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
		defaultCwd: "/srv/app",
		connection: { connectTimeoutMs: 10_000 },
	});
	await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", { displayName: "Session" });
	const broker = new FakeBroker();
	const operations = new SqliteCommandOperationRepository(backend.database);
	const sessions = new SqliteSessionRepository(backend.database);
	const service = new CommandOperationService({
		operations,
		sessions,
		targets: new DefaultSshTargetResolver({
			sessions,
			workspaces: new SqliteWorkspaceRepository(backend.database),
			credentials: new SqliteCredentialRepository(backend.database),
			hostTrust: staticHostTrust,
		}),
		guards: new DefaultCommandGuardEvaluator(new SqliteGuardRepository(backend.database)),
		broker,
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
		close: () => {
			service.close();
			backend.close();
		},
	};
}

const staticHostTrust = {
	ensureTrusted: async () => ({ algorithm: "ssh-ed25519", fingerprint: "SHA256:test", verifiedAt: 1 }),
};

async function createSession(
	backend: ReturnType<typeof createSqliteManagementBackend>,
	displayName: string,
): Promise<string> {
	const response = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", { displayName });
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
