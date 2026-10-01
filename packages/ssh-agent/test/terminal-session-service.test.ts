import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import type { SshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import { TerminalSessionService } from "../src/application/services/terminal-session-service.ts";
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

	it.each(["sandbox_unavailable", "sandbox_partial_enforcement"] as const)(
		"automatically opens an unconfined PTY only for capability verdict %s", async (code) => {
			const database = createDatabase();
			const broker = new FakeBroker();
			const service = new TerminalSessionService({ sessions: new SqliteSessionRepository(database),
				terminals: new SqliteTerminalRepository(database), targets: { resolve: async () => target }, broker,
				sandbox: { ...terminalTestSandbox, prepareTerminal: async () => { throw sandboxFailure(code, "Landlock unavailable"); } },
				lifecycle: new SessionLifecycleCoordinator(), clock: { now: () => 100 },
				ids: new SequentialIds(), hasActiveChatRun: async () => false });
			try {
				const opening = await service.open({ sessionId: "session-1", requestId: `fallback-${code}` });
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(service.get("session-1")).toMatchObject({ status: "active", requestedSandboxMode: "workspace_write",
					sandbox: { mode: "full_access", source: "sandbox_unavailable", detectedAt: 100 } });
				expect(broker.lastLaunch).toEqual({ kind: "login_shell" });
				expect((await service.open({ sessionId: "session-1", requestId: `fallback-${code}` })).id).toBe(opening.id);
				expect(broker.openCount).toBe(1);
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
});
