import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { SessionUseLease } from "../src/application/services/session-lifecycle-coordinator.ts";
import type { TerminalChannelExit, TerminalChannelHandle } from "../src/application/ssh-channel-broker.ts";
import { TerminalSessionActor } from "../src/application/terminal/terminal-session-actor.ts";
import { TerminalCanonicalState } from "../src/application/terminal/terminal-canonical-state.ts";
import { TERMINAL_DEFAULTS } from "../src/application/terminal/terminal-defaults.ts";
import type { TerminalSequencedEvent } from "../src/application/terminal/terminal-replay-ring.ts";
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
	isClosed(): boolean { return this.disposed || this.#closedState; }
	startOutput(): void {}
	readonly connectionGeneration = 4;
	readonly written: Uint8Array[] = [];
	readonly resized: TerminalGeometry[] = [];
	readonly closed: Promise<TerminalChannelExit>;
	#resolveClosed: (exit: TerminalChannelExit) => void = () => undefined;
	#closedState = false;
	disposed = false;
	closeError: Error | null = null;
	closeExit: TerminalChannelExit = { kind: "closed" };

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
		if (this.closeError) throw this.closeError;
		this.finish(this.closeExit);
	}

	finish(exit: TerminalChannelExit): void {
		this.#closedState = true;
		this.#resolveClosed(exit);
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
	requestedSandboxMode: "workspace_write",
	sandbox: null,
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

const sandbox = { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8,
	launcherVersion: "2", sandboxRoot: "/srv/test" } as const;

describe("TerminalSessionActor", () => {
	it("coalesces tiny SSH redraw fragments without losing ANSI, UTF-8 or canonical snapshot contents", async () => {
		const database = createDatabase();
		const reference = new TerminalCanonicalState(openingSession().geometry);
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			const actor = new TerminalSessionActor({ session, repository, clock: { now: () => 10 }, ids: new SequentialIds(),
				sessionLease: { release: () => undefined }, onDisposed: () => undefined });
			await actor.activate(new FakeTerminalChannel(), sandbox);
			const events: TerminalSequencedEvent[] = [];
			actor.subscribe((event) => events.push(event));
			const bytes = Buffer.from("\r\x1b[2K[arthas@1]$ 含video.merge容器=".repeat(2000) + "\r\nresult\r\nprompt$ ");
			await reference.write(bytes);
			for (let index = 0; index < bytes.length; index++) actor.acceptSshData(bytes.subarray(index, index + 1));
			const capture = await actor.captureCanonical();
			const output = events.filter((event) => event.type === "terminal.output");
			expect(output.length).toBe(Math.ceil(bytes.length / TERMINAL_DEFAULTS.replay.outputBatchBytes));
			expect(Buffer.concat(output.map((event) => Buffer.from(event.bytes)))).toEqual(bytes);
			expect(capture.screenText).toBe(reference.currentScreenText());
			expect(capture.allText).toBe(reference.allText());
			const attachment = await actor.createAttachment("request", "attachment");
			expect(attachment.snapshot.sequence).toBe(output.length);
			await actor.close("user_requested");
		} finally { reference.dispose(); database.close(); }
	});

	it("seals output batches at input and snapshot boundaries instead of moving later bytes ahead of them", async () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			const actor = new TerminalSessionActor({ session, repository, clock: { now: () => 10 }, ids: new SequentialIds(),
				sessionLease: { release: () => undefined }, onDisposed: () => undefined });
			await actor.activate(new FakeTerminalChannel(), sandbox);
			const events: TerminalSequencedEvent[] = [];
			actor.subscribe((event) => events.push(event));
			actor.acceptSshData(Buffer.from("before"));
			const input = actor.recordDurableEvent("terminal.input", { interactionId: "interaction" });
			actor.acceptSshData(Buffer.from("after"));
			const snapshot = actor.captureCanonical();
			actor.acceptSshData(Buffer.from("later"));
			expect(await input).toBe(2);
			expect(await snapshot).toMatchObject({ sequence: 3, allText: "beforeafter" });
			expect(await actor.captureCanonical()).toMatchObject({ sequence: 4, allText: "beforeafterlater" });
			expect(events.map((event) => event.type)).toEqual(["terminal.output", "terminal.input", "terminal.output", "terminal.output"]);
			await actor.close("user_requested");
		} finally { database.close(); }
	});

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

			await actor.activate(channel, sandbox);
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

	it("never persists active when the confirmed channel closed before activation", async () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			const actor = new TerminalSessionActor({ session, repository, clock: { now: () => 10 }, ids: new SequentialIds(),
				sessionLease: { release: () => undefined }, onDisposed: () => undefined });
			const channel = new FakeTerminalChannel();
			channel.dispose();
			await expect(actor.activate(channel, sandbox))
				.rejects.toMatchObject({ code: "terminal_session_unavailable" });
			expect(repository.findSession("terminal-1")).toMatchObject({ status: "opening", sandbox: null });
			await actor.failOpening("terminal_open_failed", "Channel closed");
		} finally { database.close(); }
	});

	it.each([
		[{ kind: "closed", exitCode: 0 }, "closed", "shell_exited", "terminal.closed"],
		[{ kind: "connection_lost" }, "lost", "connection_lost", "terminal.lost"],
	] as const)("records a %s channel exit as %s", async (exit, status, closeReason, timelineType) => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			let leaseReleased = false;
			let actorDisposed = false;
			const actor = new TerminalSessionActor({ session, repository, clock: { now: () => 10 }, ids: new SequentialIds(),
				sessionLease: { release: () => { leaseReleased = true; } }, onDisposed: () => { actorDisposed = true; } });
			const channel = new FakeTerminalChannel();
			await actor.activate(channel, sandbox);
			channel.finish(exit);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(repository.findSession(session.id)).toMatchObject({ status, closeReason });
			expect(repository.listTimeline(session.sessionId).some((event) => event.type === timelineType)).toBe(true);
			expect(channel.disposed).toBe(true);
			expect(leaseReleased).toBe(true);
			expect(actorDisposed).toBe(true);
		} finally { database.close(); }
	});

	it("releases the actor and records a lost session when channel close throws", async () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			let leaseReleased = false;
			let actorDisposed = false;
			const actor = new TerminalSessionActor({ session, repository, clock: { now: () => 10 }, ids: new SequentialIds(),
				sessionLease: { release: () => { leaseReleased = true; } }, onDisposed: () => { actorDisposed = true; } });
			const channel = new FakeTerminalChannel();
			channel.closeError = new Error("SSH close failed");
			await actor.activate(channel, sandbox);
			await actor.close("user_requested", "close-1");
			expect(repository.findSession(session.id)).toMatchObject({ status: "lost", closeReason: "connection_lost",
				closeRequestId: "close-1", failureCode: "channel_closed", failureMessage: "SSH close failed" });
			expect(repository.listTimeline(session.sessionId).some((event) => event.type === "terminal.lost")).toBe(true);
			expect(channel.disposed).toBe(true);
			expect(leaseReleased).toBe(true);
			expect(actorDisposed).toBe(true);
		} finally { database.close(); }
	});

	it("disposes the Shell if the final SQLite transition cannot be persisted", async () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			let leaseReleased = false;
			let actorDisposed = false;
			const actor = new TerminalSessionActor({ session, repository, clock: { now: () => 10 }, ids: new SequentialIds(),
				sessionLease: { release: () => { leaseReleased = true; } }, onDisposed: () => { actorDisposed = true; } });
			const channel = new FakeTerminalChannel();
			await actor.activate(channel, sandbox);
			vi.spyOn(repository, "updateSession").mockReturnValueOnce(false);
			channel.finish({ kind: "closed", exitCode: 0 });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(repository.findSession(session.id)?.status).toBe("active");
			expect(channel.disposed).toBe(true);
			expect(leaseReleased).toBe(true);
			expect(actorDisposed).toBe(true);
		} finally { database.close(); }
	});

	it("does not mark a disconnect during an explicit close as a clean shutdown", async () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			const session = openingSession();
			repository.insertSession(session);
			const actor = new TerminalSessionActor({ session, repository, clock: { now: () => 10 }, ids: new SequentialIds(),
				sessionLease: { release: () => undefined }, onDisposed: () => undefined });
			const channel = new FakeTerminalChannel();
			channel.closeExit = { kind: "connection_lost" };
			await actor.activate(channel, sandbox);
			await actor.close("user_requested", "close-1");
			expect(repository.findSession(session.id)).toMatchObject({ status: "lost", closeReason: "connection_lost" });
			expect(channel.disposed).toBe(true);
		} finally { database.close(); }
	});
});
