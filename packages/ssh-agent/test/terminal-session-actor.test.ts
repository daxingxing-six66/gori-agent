import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SessionUseLease } from "../src/application/services/session-lifecycle-coordinator.ts";
import type { TerminalChannelExit, TerminalChannelHandle } from "../src/application/ssh-channel-broker.ts";
import { TerminalSessionActor } from "../src/application/terminal/terminal-session-actor.ts";
import type { Clock, IdGenerator } from "../src/domain/ids.ts";
import type { TerminalGeometry, TerminalSession } from "../src/domain/terminal.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";

class SequentialIds implements IdGenerator {
	#next = 1;

	next(): string {
		const value = `id-${this.#next}`;
		this.#next += 1;
		return value;
	}
}

class FakeTerminalChannel implements TerminalChannelHandle {
	readonly connectionGeneration = 4;
	readonly written: Uint8Array[] = [];
	readonly resized: TerminalGeometry[] = [];
	readonly closed: Promise<TerminalChannelExit>;
	#resolveClosed: (exit: TerminalChannelExit) => void = () => undefined;
	disposed = false;

	constructor() {
		this.closed = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	async write(data: Uint8Array): Promise<void> {
		this.written.push(data.slice());
	}

	async resize(geometry: TerminalGeometry): Promise<void> {
		this.resized.push(geometry);
	}

	setReadPaused(): void {}

	async close(): Promise<void> {
		this.#resolveClosed({ kind: "closed" });
	}

	dispose(): void {
		this.disposed = true;
	}
}

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

const openingSession = (): TerminalSession => ({
	id: "terminal-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	openRequestId: "open-1",
	closeRequestId: null,
	status: "opening",
	revision: 1,
	geometry: { rows: 36, cols: 120 },
	eventSequence: 0,
	ownershipEpoch: 0,
	connectionGeneration: null,
	term: "xterm-256color",
	activatedAt: null,
	lastConsumerActivityAt: 1,
	idleDeadlineAt: null,
	closingAt: null,
	closedAt: null,
	closeReason: null,
	failureCode: null,
	failureMessage: null,
	createdAt: 1,
	updatedAt: 1,
});

describe("TerminalSessionActor", () => {
	it("serializes canonical output, attachment replay, ownership, resize and close", async () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			let now = 10;
			const clock: Clock = { now: () => now++ };
			let leaseReleased = false;
			const lease: SessionUseLease = {
				release: () => {
					leaseReleased = true;
				},
			};
			let actorDisposed = false;
			const actor = new TerminalSessionActor({
				session,
				repository,
				clock,
				ids: new SequentialIds(),
				sessionLease: lease,
				onDisposed: () => {
					actorDisposed = true;
				},
			});
			const channel = new FakeTerminalChannel();
			const events: number[] = [];
			actor.subscribe((event) => events.push(event.sequence));

			await actor.activate(channel);
			actor.acceptSshData(new TextEncoder().encode("prompt$ "));
			const bootstrap = await actor.createAttachment("request-1", "attachment-1");
			expect(bootstrap.snapshot.sequence).toBe(1);
			actor.acceptSshData(new TextEncoder().encode("next\r\n"));
			const replay = await actor.prepareReplay("attachment-1", bootstrap.snapshot.sequence);
			expect(replay.events.map((event) => event.sequence)).toEqual([2]);
			await actor.markAttachmentReady("attachment-1", 2);
			const ownership = await actor.claimResizeOwnership("attachment-1");
			expect(ownership).toEqual({ owner: true, ownershipEpoch: 1 });
			await actor.resize("attachment-1", 1, { rows: 40, cols: 132 });
			expect(channel.resized).toEqual([{ rows: 40, cols: 132 }]);
			expect(events).toEqual([1, 2, 3, 4]);

			await actor.close("user_requested", "close-1");
			expect(repository.findSession("terminal-1")).toMatchObject({
				status: "closed",
				closeRequestId: "close-1",
				closeReason: "user_requested",
			});
			expect(channel.disposed).toBe(true);
			expect(leaseReleased).toBe(true);
			expect(actorDisposed).toBe(true);
		} finally {
			database.close();
		}
	});
});
