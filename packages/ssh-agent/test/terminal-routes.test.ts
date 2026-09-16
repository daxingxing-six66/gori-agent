import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { handleTerminalRoute } from "../src/api/terminal-routes.ts";
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
	readonly connectionGeneration = 1;
	readonly closed: Promise<TerminalChannelExit>;
	readonly resized: TerminalGeometry[] = [];
	#resolveClosed: (exit: TerminalChannelExit) => void = () => undefined;
	#onData: (bytes: Uint8Array) => void = () => undefined;

	constructor(onData: (bytes: Uint8Array) => void) {
		this.#onData = onData;
		this.closed = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	emit(text: string): void {
		this.#onData(new TextEncoder().encode(text));
	}

	async write(): Promise<void> {}
	async resize(geometry: TerminalGeometry): Promise<void> {
		this.resized.push(geometry);
	}
	setReadPaused(): void {}
	async close(): Promise<void> {
		this.#resolveClosed({ kind: "closed" });
	}
	dispose(): void {}
}

class FakeBroker implements TerminalChannelBroker {
	handle: FakeHandle | undefined;
	async open(input: Parameters<TerminalChannelBroker["open"]>[0]): Promise<TerminalChannelHandle> {
		this.handle = new FakeHandle(input.onData);
		return this.handle;
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

function createDatabase(): DatabaseSync {
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
}

function request(path: string, method = "GET", body?: unknown): Request {
	return new Request(`http://test.local${path}`, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}

async function route(service: TerminalSessionService, input: Request): Promise<Response> {
	const url = new URL(input.url);
	const segments = url.pathname.split("/").filter(Boolean);
	const response = await handleTerminalRoute(service, input, url, segments);
	if (response === null) throw new Error("Terminal route did not match");
	return response;
}

describe("Terminal routes", () => {
	it("opens, bootstraps, streams, owns resize and closes a TerminalSession", async () => {
		const database = createDatabase();
		const broker = new FakeBroker();
		const clock: Clock = { now: () => Date.now() };
		const targets: SshTargetResolver = { resolve: async () => target };
		const service = new TerminalSessionService({
			sessions: new SqliteSessionRepository(database),
			terminals: new SqliteTerminalRepository(database),
			targets,
			broker,
			lifecycle: new SessionLifecycleCoordinator(),
			clock,
			ids: new SequentialIds(),
			hasActiveChatRun: async () => false,
		});
		try {
			const open = await route(
				service,
				request("/api/sessions/session-1/terminal/open", "POST", { requestId: "open-1", rows: 30, cols: 100 }),
			);
			expect(open.status).toBe(202);
			const terminal = (await open.json()) as { id: string };
			await new Promise<void>((resolve) => setImmediate(resolve));

			broker.handle?.emit("hello\r\n$ ");
			const attach = await route(
				service,
				request("/api/sessions/session-1/terminal/attachments", "POST", { requestId: "attach-1" }),
			);
			expect(attach.status).toBe(201);
			const bootstrap = (await attach.json()) as { attachmentId: string; snapshot: { sequence: number } };
			const events = await route(
				service,
				request(
					`/api/sessions/session-1/terminal/attachments/${bootstrap.attachmentId}/events?afterSequence=${bootstrap.snapshot.sequence}`,
				),
			);
			expect(events.headers.get("content-type")).toBe("text/event-stream");
			const reader = events.body?.getReader();
			const first = await reader?.read();
			expect(new TextDecoder().decode(first?.value)).toContain("terminal.stream.ready");

			await route(
				service,
				request(`/api/sessions/session-1/terminal/attachments/${bootstrap.attachmentId}/ready`, "POST", {
					replayedThroughSequence: bootstrap.snapshot.sequence,
				}),
			);
			const focus = await route(
				service,
				request(`/api/sessions/session-1/terminal/attachments/${bootstrap.attachmentId}/focus`, "POST", {
					focused: true,
				}),
			);
			const ownership = (await focus.json()) as { ownershipEpoch: number };
			await route(
				service,
				request(`/api/sessions/session-1/terminal/attachments/${bootstrap.attachmentId}/resize`, "POST", {
					ownershipEpoch: ownership.ownershipEpoch,
					rows: 40,
					cols: 132,
				}),
			);
			expect(broker.handle?.resized).toEqual([{ rows: 40, cols: 132 }]);

			await reader?.cancel();
			const close = await route(
				service,
				request("/api/sessions/session-1/terminal/close", "POST", {
					requestId: "close-1",
					terminalSessionId: terminal.id,
				}),
			);
			expect(close.status).toBe(202);
			expect(await close.json()).toMatchObject({ status: "closed" });
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	it("rejects unknown request fields", async () => {
		const database = createDatabase();
		const service = new TerminalSessionService({
			sessions: new SqliteSessionRepository(database),
			terminals: new SqliteTerminalRepository(database),
			targets: { resolve: async () => target },
			broker: new FakeBroker(),
			lifecycle: new SessionLifecycleCoordinator(),
			clock: { now: () => 1 },
			ids: new SequentialIds(),
			hasActiveChatRun: async () => false,
		});
		try {
			await expect(
				route(
					service,
					request("/api/sessions/session-1/terminal/open", "POST", { requestId: "open-1", extra: true }),
				),
			).rejects.toMatchObject({ code: "validation_error" });
		} finally {
			await service.shutdown();
			database.close();
		}
	});
});
