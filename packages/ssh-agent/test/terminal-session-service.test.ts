import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import type { SshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import { TerminalSessionService } from "../src/application/services/terminal-session-service.ts";
import { TerminalRuntimeRegistry } from "../src/application/terminal/terminal-runtime-registry.ts";
import type {
	TerminalChannelBroker,
	TerminalChannelExit,
	TerminalChannelHandle,
} from "../src/application/ssh-channel-broker.ts";
import type { Clock, IdGenerator } from "../src/domain/ids.ts";
import { sandboxFailure } from "../src/domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import type { TerminalGeometry, TerminalSession } from "../src/domain/terminal.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";
import { terminalTestSandbox } from "./terminal-test-sandbox.ts";

class SequentialIds implements IdGenerator {
	#next = 1;

	next(): string {
		return `id-${this.#next++}`;
	}
}

class FakeHandle implements TerminalChannelHandle {
	isClosed(): boolean { return false; }
	startOutput(): void {}
	readonly connectionGeneration = 2;
	readonly closed: Promise<TerminalChannelExit>;
	#resolveClosed: (exit: TerminalChannelExit) => void = () => undefined;

	constructor() {
		this.closed = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	async write(): Promise<void> {}
	async resize(_geometry: TerminalGeometry): Promise<void> {}
	setReadPaused(): void {}
	async close(): Promise<void> {
		this.#resolveClosed({ kind: "closed" });
	}
	dispose(): void {}
}

class FakeBroker implements TerminalChannelBroker {
	openCount = 0;
	lastLaunch: Parameters<TerminalChannelBroker["open"]>[0]["launch"] | null = null;

	async open(input: Parameters<TerminalChannelBroker["open"]>[0]): Promise<TerminalChannelHandle> {
		this.openCount += 1;
		this.lastLaunch = input.launch;
		return new FakeHandle();
	}
}

class HangingBroker implements TerminalChannelBroker {
	open(input: Parameters<TerminalChannelBroker["open"]>[0]): Promise<TerminalChannelHandle> {
		return new Promise((_resolve, reject) => {
			input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	}
}

const target: SshTargetSnapshot = {
	workspaceId: "workspace-1",
	workspaceRevision: 1,
	credentialId: "credential-1",
	credentialAuthVersion: 1,
	hostname: "localhost",
	port: 22,
	remoteUser: "root",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:test",
	connectTimeoutMs: 1000,
	keepaliveIntervalMs: 1000,
	keepaliveMaxCount: 3,
	defaultCwd: "/tmp",
};

const createDatabase = (): DatabaseSync => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	applyMigrations(database);
	database.exec(`
		INSERT INTO workspaces (
			id, display_name, environment, hostname, port, default_cwd, connect_timeout_ms,
			keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at
		) VALUES ('workspace-1', 'test', 'development', 'localhost', 22, '/tmp', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (
			id, workspace_id, display_name, terminal_context_cursor, revision, created_at, updated_at
		) VALUES ('session-1', 'workspace-1', 'test', 0, 1, 1, 1);
	`);
	return database;
};

function setupService(options: Partial<ConstructorParameters<typeof TerminalSessionService>[0]> = {}) {
	const database = createDatabase();
	const repository = new SqliteTerminalRepository(database);
	const registry = new TerminalRuntimeRegistry({ capacity: 1 });
	const lifecycle = new SessionLifecycleCoordinator();
	const broker = new FakeBroker();
	const service = new TerminalSessionService({
		sessions: new SqliteSessionRepository(database), terminals: repository,
		targets: { resolve: async () => target }, broker, sandbox: terminalTestSandbox,
		lifecycle, registry, clock: { now: () => Date.now() }, ids: new SequentialIds(),
		hasActiveChatRun: async () => false, openTimeoutMs: 10, ...options,
	});
	return { database, repository, registry, lifecycle, broker, service };
}

describe("TerminalSessionService", () => {
	it("marks an active Terminal Session as lost when its runtime is absent during close", async () => {
		const database = createDatabase();
		try {
			const terminals = new SqliteTerminalRepository(database);
			const orphaned: TerminalSession = {
				id: "terminal-orphaned",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				openRequestId: "open-orphaned",
				closeRequestId: null,
				status: "active",
				requestedSandboxMode: null,
				sandbox: null,
				revision: 1,
				geometry: { rows: 36, cols: 120 },
				eventSequence: 3,
				ownershipEpoch: 0,
				connectionGeneration: 2,
				term: "xterm-256color",
				activatedAt: 50,
				lastConsumerActivityAt: 50,
				idleDeadlineAt: null,
				closingAt: null,
				closedAt: null,
				closeReason: null,
				failureCode: null,
				failureMessage: null,
				createdAt: 1,
				updatedAt: 50,
			};
			terminals.insertSession(orphaned);
			const service = new TerminalSessionService({
				sessions: new SqliteSessionRepository(database),
				terminals,
				targets: { resolve: async () => target },
				broker: new FakeBroker(),
				sandbox: terminalTestSandbox,
				lifecycle: new SessionLifecycleCoordinator(),
				clock: { now: () => 100 },
				ids: new SequentialIds(),
				hasActiveChatRun: async () => false,
			});
			try {
				await expect(service.attach("session-1", "attach-1")).rejects.toMatchObject({
					code: "terminal_session_not_found",
				});
				const closed = await service.close({
					sessionId: "session-1", terminalSessionId: orphaned.id, requestId: "close-1",
				});
				expect(closed).toMatchObject({
					status: "lost", closeRequestId: "close-1", closeReason: "connection_lost", closedAt: 100,
				});
				expect((await service.getStatus("session-1")).effectiveServerInteractionMode).toBe("command");
				expect(service.listTimeline("session-1")).toEqual([
					expect.objectContaining({ type: "terminal.lost", terminalSessionId: orphaned.id }),
				]);
				expect((await service.close({ sessionId: "session-1", terminalSessionId: orphaned.id, requestId: "close-1" })).revision).toBe(2);
			} finally {
				await service.shutdown();
			}
		} finally {
			database.close();
		}
	});

	it("opens idempotently, activates in the background and closes without leaking the Session lease", async () => {
		const database = createDatabase();
		try {
			const terminals = new SqliteTerminalRepository(database);
			const lifecycle = new SessionLifecycleCoordinator();
			const broker = new FakeBroker();
			const clock: Clock = { now: () => 100 };
			const targets: SshTargetResolver = { resolve: async () => target };
			const service = new TerminalSessionService({
				sessions: new SqliteSessionRepository(database),
				terminals,
				targets,
				broker,
				sandbox: terminalTestSandbox,
				lifecycle,
				clock,
				ids: new SequentialIds(),
				hasActiveChatRun: async () => false,
			});

			const opening = await service.open({ sessionId: "session-1", requestId: "open-1" });
			const repeated = await service.open({ sessionId: "session-1", requestId: "open-1" });
			expect(repeated.id).toBe(opening.id);
			await new Promise<void>((resolve) => setImmediate(resolve));
				expect(service.get("session-1")).toMatchObject({ status: "active", connectionGeneration: 2 });
				expect(broker.openCount).toBe(1);
				expect(broker.lastLaunch).toMatchObject({ kind: "sandboxed_exec" });
				expect(lifecycle.getUsage("session-1").byKind.terminal_session).toBe(1);

			await service.close({
				sessionId: "session-1",
				terminalSessionId: opening.id,
				requestId: "close-1",
			});
			expect(service.get("session-1")).toMatchObject({ status: "closed", closeRequestId: "close-1" });
			expect(lifecycle.getUsage("session-1").byKind.terminal_session).toBe(0);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	it("rejects opening while a Chat Run is active", async () => {
		const database = createDatabase();
		try {
			const service = new TerminalSessionService({
				sessions: new SqliteSessionRepository(database),
				terminals: new SqliteTerminalRepository(database),
				targets: { resolve: async () => target },
				broker: new FakeBroker(),
				sandbox: terminalTestSandbox,
				lifecycle: new SessionLifecycleCoordinator(),
				clock: { now: () => 100 },
				ids: new SequentialIds(),
				hasActiveChatRun: async () => true,
			});

			await expect(service.open({ sessionId: "session-1", requestId: "open-1" })).rejects.toMatchObject({
				code: "session_has_active_chat_run",
			});
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	it("fails and releases resources when opening the SSH terminal channel times out", async () => {
		const database = createDatabase();
		try {
			const lifecycle = new SessionLifecycleCoordinator();
			const service = new TerminalSessionService({
				sessions: new SqliteSessionRepository(database),
				terminals: new SqliteTerminalRepository(database),
				targets: { resolve: async () => target },
				broker: new HangingBroker(),
				sandbox: terminalTestSandbox,
				lifecycle,
				clock: { now: () => 100 },
				ids: new SequentialIds(),
				hasActiveChatRun: async () => false,
				openTimeoutMs: 10,
			});

			const opening = await service.open({ sessionId: "session-1", requestId: "open-timeout" });
			expect(opening.status).toBe("opening");
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			expect(service.get("session-1")).toMatchObject({
				status: "failed",
				requestedSandboxMode: "workspace_write",
				sandbox: null,
				failureCode: "terminal_open_timeout",
				closeReason: "open_failed",
			});
			expect(lifecycle.getUsage("session-1").byKind.terminal_session).toBe(0);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	it.each(["sandbox_unavailable", "sandbox_partial_enforcement", "sandbox_bubblewrap_not_installed"] as const)(
		"fails closed without opening a PTY when sandbox capability reports %s", async (code) => {
			const database = createDatabase();
			const broker = new FakeBroker();
			const lifecycle = new SessionLifecycleCoordinator();
			const service = new TerminalSessionService({ sessions: new SqliteSessionRepository(database),
				terminals: new SqliteTerminalRepository(database), targets: { resolve: async () => target }, broker,
				sandbox: { ...terminalTestSandbox, prepareTerminal: async () => { throw sandboxFailure(code, "No usable sandbox backend"); } },
				lifecycle, clock: { now: () => 100 },
				ids: new SequentialIds(), hasActiveChatRun: async () => false });
			try {
				const opening = await service.open({ sessionId: "session-1", requestId: `failed-${code}` });
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(service.get("session-1")).toMatchObject({ status: "failed", requestedSandboxMode: "workspace_write",
					sandbox: null, failureCode: code, closeReason: "open_failed" });
				expect((await service.open({ sessionId: "session-1", requestId: `failed-${code}` })).id).toBe(opening.id);
				expect(broker.openCount).toBe(0);
				expect(broker.lastLaunch).toBeNull();
				expect(lifecycle.getUsage("session-1").byKind.terminal_session).toBe(0);
			} finally { await service.shutdown(); database.close(); }
		},
	);

	it.each(["sandbox_root_invalid", "sandbox_launcher_upload_failed", "sandbox_probe_failed", "sandbox_unsupported_platform", "sandbox_unsupported_architecture"] as const)(
		"does not downgrade a failed sandbox preparation %s", async (code) => {
			const database = createDatabase();
			const broker = new FakeBroker();
			const service = new TerminalSessionService({ sessions: new SqliteSessionRepository(database),
				terminals: new SqliteTerminalRepository(database), targets: { resolve: async () => target }, broker,
				sandbox: { ...terminalTestSandbox, prepareTerminal: async () => { throw sandboxFailure(code, "Preparation failed"); } },
				lifecycle: new SessionLifecycleCoordinator(), clock: { now: () => 100 },
				ids: new SequentialIds(), hasActiveChatRun: async () => false });
			try {
				await service.open({ sessionId: "session-1", requestId: `failed-${code}` });
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(service.get("session-1")).toMatchObject({ status: "failed", sandbox: null, failureCode: code });
				expect(broker.openCount).toBe(0);
			} finally { await service.shutdown(); database.close(); }
		},
	);

	it("stops before sandbox preparation when a target resolves after the opening deadline", async () => {
		vi.useFakeTimers();
		let resolveTarget: (value: SshTargetSnapshot) => void = () => undefined;
		const resolved = new Promise<SshTargetSnapshot>((resolve) => { resolveTarget = resolve; });
		const prepareTerminal = vi.fn(terminalTestSandbox.prepareTerminal);
		const context = setupService({
			targets: { resolve: async () => resolved }, sandbox: { ...terminalTestSandbox, prepareTerminal },
		});
		try {
			await context.service.open({ sessionId: "session-1", requestId: "late-target" });
			await vi.advanceTimersByTimeAsync(10);
			expect(context.service.get("session-1")).toMatchObject({ status: "failed", failureCode: "terminal_open_timeout" });
			expect(context.registry.reservationCount).toBe(0);
			expect(context.lifecycle.getUsage("session-1").byKind.terminal_session).toBe(0);
			resolveTarget(target);
			await vi.advanceTimersByTimeAsync(0);
			expect(prepareTerminal).not.toHaveBeenCalled();
			expect(context.broker.openCount).toBe(0);
		} finally {
			await context.service.shutdown();
			context.database.close();
			vi.useRealTimers();
		}
	});

	it("stops before PTY dispatch when sandbox preparation resolves after the opening deadline", async () => {
		vi.useFakeTimers();
		const prepared = await terminalTestSandbox.prepareTerminal({ target, signal: new AbortController().signal });
		let resolvePreparation: (value: typeof prepared) => void = () => undefined;
		const preparation = new Promise<typeof prepared>((resolve) => { resolvePreparation = resolve; });
		const context = setupService({ sandbox: { ...terminalTestSandbox, prepareTerminal: async () => preparation } });
		try {
			await context.service.open({ sessionId: "session-1", requestId: "late-preparation" });
			await vi.advanceTimersByTimeAsync(10);
			expect(context.service.get("session-1")).toMatchObject({ status: "failed", failureCode: "terminal_open_timeout" });
			resolvePreparation(prepared);
			await vi.advanceTimersByTimeAsync(0);
			expect(context.broker.openCount).toBe(0);
			expect(context.registry.reservationCount).toBe(0);
		} finally {
			await context.service.shutdown();
			context.database.close();
			vi.useRealTimers();
		}
	});

	it.each(["timeout", "close"] as const)("disposes a channel returned after %s without activating it", async (interruption) => {
		vi.useFakeTimers();
		let resolveChannel: (channel: TerminalChannelHandle) => void = () => undefined;
		const pending = new Promise<TerminalChannelHandle>((resolve) => { resolveChannel = resolve; });
		const handle = new FakeHandle();
		const dispose = vi.spyOn(handle, "dispose");
		const startOutput = vi.spyOn(handle, "startOutput");
		const context = setupService({ broker: { open: async () => pending } });
		try {
			const opening = await context.service.open({ sessionId: "session-1", requestId: `late-channel-${interruption}` });
			await vi.advanceTimersByTimeAsync(0);
			if (interruption === "timeout") await vi.advanceTimersByTimeAsync(10);
			else await context.service.close({ sessionId: "session-1", terminalSessionId: opening.id, requestId: "close-pending" });
			expect(context.service.get("session-1")?.status).toBe(interruption === "timeout" ? "failed" : "closed");
			expect(context.registry.reservationCount).toBe(0);
			expect(context.lifecycle.getUsage("session-1").byKind.terminal_session).toBe(0);
			resolveChannel(handle);
			await vi.advanceTimersByTimeAsync(0);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(startOutput).not.toHaveBeenCalled();
			expect(context.service.get("session-1")?.status).toBe(interruption === "timeout" ? "failed" : "closed");
		} finally {
			await context.service.shutdown();
			context.database.close();
			vi.useRealTimers();
		}
	});

	it("does not create a runtime if shutdown happens while open validation is awaiting", async () => {
		let finishValidation: (value: boolean) => void = () => undefined;
		let started: () => void = () => undefined;
		const waiting = new Promise<void>((resolve) => { started = resolve; });
		const validation = new Promise<boolean>((resolve) => { finishValidation = resolve; });
		const context = setupService({ hasActiveChatRun: async () => { started(); return validation; } });
		try {
			const opening = context.service.open({ sessionId: "session-1", requestId: "shutdown-during-validation" });
			await waiting;
			await context.service.shutdown();
			finishValidation(false);
			await expect(opening).rejects.toMatchObject({ code: "terminal_session_unavailable" });
			expect(context.service.get("session-1")).toBeNull();
			expect(context.registry.reservationCount).toBe(0);
			expect(context.lifecycle.getUsage("session-1").total).toBe(0);
			expect(context.broker.openCount).toBe(0);
		} finally {
			await context.service.shutdown();
			context.database.close();
		}
	});

	it("admits only one runtime when concurrent opens finish asynchronous validation", async () => {
		const context = setupService();
		try {
			const results = await Promise.allSettled([
				context.service.open({ sessionId: "session-1", requestId: "concurrent-1" }),
				context.service.open({ sessionId: "session-1", requestId: "concurrent-2" }),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((result) => result.status === "rejected");
			expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({ code: "terminal_session_already_active" });
			expect(context.registry.reservationCount).toBe(1);
			expect(context.lifecycle.getUsage("session-1").byKind.terminal_session).toBe(1);
		} finally {
			await context.service.shutdown();
			context.database.close();
		}
	});

	it.each(["insert_session", "opening_timeline"] as const)("releases both leases and capacity when %s fails", async (stage) => {
		const context = setupService();
		try {
			if (stage === "insert_session") vi.spyOn(context.repository, "insertSession").mockImplementationOnce(() => { throw new Error("insert failed"); });
			else vi.spyOn(context.repository, "appendTimelineEvent").mockImplementationOnce(() => { throw new Error("timeline failed"); });
			await expect(context.service.open({ sessionId: "session-1", requestId: `initialization-${stage}` })).rejects.toThrow();
			expect(context.registry.reservationCount).toBe(0);
			expect(context.registry.list()).toEqual([]);
			expect(context.lifecycle.getUsage("session-1").total).toBe(0);
			expect(context.broker.openCount).toBe(0);
			if (stage === "opening_timeline") {
				expect(context.service.get("session-1")).toMatchObject({ status: "failed", failureCode: "terminal_initialization_failed" });
			}
		} finally {
			await context.service.shutdown();
			context.database.close();
		}
	});
});
