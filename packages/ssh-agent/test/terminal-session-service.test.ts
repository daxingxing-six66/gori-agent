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
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import type { TerminalGeometry } from "../src/domain/terminal.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";

class SequentialIds implements IdGenerator {
	#next = 1;

	next(): string {
		return `id-${this.#next++}`;
	}
}

class FakeHandle implements TerminalChannelHandle {
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

	async open(): Promise<TerminalChannelHandle> {
		this.openCount += 1;
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
				failureCode: "terminal_open_timeout",
				closeReason: "open_failed",
			});
			expect(lifecycle.getUsage("session-1").byKind.terminal_session).toBe(0);
			await service.shutdown();
		} finally {
			database.close();
		}
	});
});
