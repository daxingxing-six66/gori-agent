import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type {
	CommandGuardDecision,
	CommandGuardEvaluator,
} from "../src/application/services/command-guard-evaluator.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
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
	readonly written: Uint8Array[] = [];
	#resolveClosed: (exit: TerminalChannelExit) => void = () => undefined;
	#onData: (bytes: Uint8Array) => void;

	constructor(onData: (bytes: Uint8Array) => void) {
		this.#onData = onData;
		this.closed = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	async write(data: Uint8Array): Promise<void> {
		this.written.push(data.slice());
		this.#onData(new TextEncoder().encode("result\r\n$ "));
	}
	emit(text: string): void {
		this.#onData(new TextEncoder().encode(text));
	}
	async resize(_geometry: TerminalGeometry): Promise<void> {}
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

class Decisions implements CommandGuardEvaluator {
	readonly #decisions: CommandGuardDecision[];
	constructor(decisions: CommandGuardDecision[]) {
		this.#decisions = decisions;
	}
	async evaluate(): Promise<CommandGuardDecision> {
		return this.#decisions.shift() ?? { allowed: true };
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
		INSERT INTO chat_runs (
			id, session_id, workspace_id, request_id, provider_id, model_id, thinking_level,
			status, created_at, updated_at, server_interaction_mode
		) VALUES ('run-1', 'session-1', 'workspace-1', 'run-request', 'test', 'test', 'off',
			'running', 1, 1, 'terminal');
	`);
	return database;
}

async function setup(guards: CommandGuardEvaluator) {
	const database = createDatabase();
	const repository = new SqliteTerminalRepository(database);
	const broker = new FakeBroker();
	const ids = new SequentialIds();
	const clock: Clock = { now: () => Date.now() };
	const terminals = new TerminalSessionService({
		sessions: new SqliteSessionRepository(database),
		terminals: repository,
		targets: { resolve: async () => target },
		broker,
		lifecycle: new SessionLifecycleCoordinator(),
		clock,
		ids,
		hasActiveChatRun: async () => false,
	});
	const terminal = await terminals.open({ sessionId: "session-1", requestId: "open-1" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	database.prepare("UPDATE chat_runs SET terminal_session_id = ? WHERE id = 'run-1'").run(terminal.id);
	return {
		database,
		repository,
		broker,
		terminals,
		interactions: new TerminalInteractionService({
			repository,
			sessions: new SqliteSessionRepository(database),
			terminals,
			guards,
			clock,
			ids,
		}),
		terminal,
	};
}

describe("TerminalInteractionService", () => {
	it.each(["observe", "submit", "key"] as const)("reads gap output with %s and preserves output arriving before delivery", async (action) => {
		const context = await setup(new Decisions([]));
		try {
			const base = { sessionId: "session-1", terminalSessionId: context.terminal.id, agentRunId: "run-1", expectation: "finite" as const };
			const emit = async (text: string) => {
				context.broker.handle!.emit(text);
				await context.terminals.getActor("session-1")!.captureCanonical();
			};
			await emit("READY\r\n$ ");
			const first = await context.interactions.execute({ ...base, toolCallId: "ready", action: { type: "observe" } });
			expect(first.observation.agentViewText).toContain("READY");
			await context.interactions.markDelivered(first);
			await emit("\r\nGAP-MARKER\r\n$ ");
			const request = { ...base, toolCallId: "gap", action: action === "submit" ? { type: "submit" as const, input: "echo probe" } : action === "key" ? { type: "key" as const, key: "CTRL_C" as const } : { type: "observe" as const } };
			if (action === "submit") await context.interactions.preflightSubmit(request, false);
			const second = await context.interactions.execute(request);
			expect(second.observation.startSequence).toBe(first.observation.endSequence);
			expect(second.observation.agentViewText).toContain("GAP-MARKER");
			expect(second.observation.agentViewText).not.toContain("READY");
			expect(second.observation.rawByteCount).toBeGreaterThan(0);
			await emit("\r\nAFTER-CAPTURE\r\n$ ");
			await context.interactions.markDelivered(second);
			const third = await context.interactions.execute({ ...base, toolCallId: "later", action: { type: "observe" } });
			expect(third.observation.agentViewText).toContain("AFTER-CAPTURE");
			expect(third.observation.agentViewText).not.toContain("GAP-MARKER");
			await context.interactions.markDelivered(third);
			vi.useFakeTimers();
			const empty = context.interactions.execute({ ...base, toolCallId: "empty", action: { type: "observe" } });
			await vi.advanceTimersByTimeAsync(30_000);
			expect((await empty).observation).toMatchObject({ agentViewText: "", rawByteCount: 0 });
		} finally {
			vi.useRealTimers();
			await context.terminals.shutdown();
			context.database.close();
		}
	});

	it("retains unread output after cancellation and failed delivery with idempotent retry", async () => {
		const context = await setup(new Decisions([]));
		try {
			const base = { sessionId: "session-1", terminalSessionId: context.terminal.id, agentRunId: "run-1", expectation: "finite" as const, action: { type: "observe" as const } };
			context.broker.handle!.emit("UNREAD\r\n$ ");
			await context.terminals.getActor("session-1")!.captureCanonical();
			await expect(context.interactions.execute({ ...base, toolCallId: "cancel" }, AbortSignal.abort())).rejects.toMatchObject({ name: "TerminalObservationCancelledError" });
			const request = { ...base, toolCallId: "retry" };
			const result = await context.interactions.execute(request);
			expect(result.observation.agentViewText).toContain("UNREAD");
			const failure = vi.spyOn(context.repository, "markObservationStage").mockReturnValueOnce(false);
			await expect(context.interactions.markDelivered(result)).rejects.toMatchObject({ code: "terminal_persistence_failed" });
			failure.mockRestore();
			const retried = await context.interactions.execute(request);
			expect(retried.observation.id).toBe(result.observation.id);
			await context.interactions.markDelivered(retried);
			context.broker.handle!.emit("\r\nNEW\r\n$ ");
			const next = await context.interactions.execute({ ...base, toolCallId: "next" });
			expect(next.observation.agentViewText).toContain("NEW");
			expect(next.observation.agentViewText).not.toContain("UNREAD");
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});

	it("warns and returns retained text when replay has overflowed", async () => {
		const context = await setup(new Decisions([]));
		try {
			for (let i = 0; i < 4100; i++) context.broker.handle!.emit(`line-${i}\r\n`);
			await context.terminals.getActor("session-1")!.captureCanonical();
			const result = await context.interactions.execute({ sessionId: "session-1", terminalSessionId: context.terminal.id, agentRunId: "run-1", toolCallId: "overflow", expectation: "finite", action: { type: "observe" } });
			expect(result.observation.truncated).toBe(true);
			expect(result.observation.agentViewText).toContain("Terminal history may be incomplete");
			expect(result.observation.agentViewText).toContain("line-4099");
			await context.interactions.markDelivered(result);
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	}, 15_000);

	it("persists approved input bytes, observation and timeline before returning", async () => {
		const context = await setup(
			new Decisions([
				{ allowed: true, guardRevision: 1 },
				{ allowed: true, guardRevision: 1 },
			]),
		);
		try {
			const request = {
				sessionId: "session-1",
				terminalSessionId: context.terminal.id,
				agentRunId: "run-1",
				toolCallId: "tool-1",
				action: { type: "submit" as const, input: "printf 'ok'\necho done" },
				expectation: "finite" as const,
			};
			expect(await context.interactions.preflightSubmit(request, true)).toMatchObject({ allowed: true });
			context.interactions.approve("run-1", "tool-1");
			const result = await context.interactions.execute(request);
			expect(new TextDecoder().decode(context.broker.handle?.written[0])).toBe("printf 'ok'\recho done\r");
			expect(result.interaction.status).toBe("completed");
			expect(result.observation).toMatchObject({ boundaryReason: "prompt", kind: "transcript" });
			expect(result.observation.agentViewText).toContain("result");
			await context.interactions.markDelivered(result);
			expect(context.repository.findObservation(result.observation.id)?.deliveredAt).not.toBeNull();
			expect(context.repository.listTimeline("session-1").map((event) => event.type)).toEqual(
				expect.arrayContaining(["terminal.input", "observation.captured", "observation.delivered"]),
			);
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});

	it("rechecks Guard after approval and never writes a newly blocked input", async () => {
		const context = await setup(
			new Decisions([
				{ allowed: true, guardRevision: 1 },
				{
					allowed: false,
					guardRevision: 2,
					matchedRule: {
						id: "rule-1",
						displayName: "blocked",
						pattern: "rm",
						match: "contains",
						reason: "blocked after approval",
						enabled: true,
						source: "user",
						level: "critical",
					},
				},
			]),
		);
		try {
			const request = {
				sessionId: "session-1",
				terminalSessionId: context.terminal.id,
				agentRunId: "run-1",
				toolCallId: "tool-2",
				action: { type: "submit" as const, input: "rm /tmp/example" },
				expectation: "finite" as const,
			};
			await context.interactions.preflightSubmit(request, true);
			context.interactions.approve("run-1", "tool-2");
			await expect(context.interactions.execute(request)).rejects.toMatchObject({ code: "guard_blocked" });
			expect(context.broker.handle?.written).toEqual([]);
			expect(context.repository.findInteractionByToolCall("run-1", "tool-2")?.status).toBe("rejected");
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});

	it("marks an observation-only interaction cancelled when its Chat Run signal is aborted", async () => {
		const context = await setup(new Decisions([]));
		try {
			const controller = new AbortController();
			controller.abort();
			const request = {
				sessionId: "session-1",
				terminalSessionId: context.terminal.id,
				agentRunId: "run-1",
				toolCallId: "tool-cancelled",
				action: { type: "observe" as const },
				expectation: "finite" as const,
			};

			await expect(context.interactions.execute(request, controller.signal)).rejects.toMatchObject({
				name: "TerminalObservationCancelledError",
			});
			expect(context.repository.findInteractionByToolCall("run-1", "tool-cancelled")).toMatchObject({
				status: "cancelled",
				failure: { code: "run_cancelled" },
			});
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});
});
