import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type {
	CommandGuardDecision,
	CommandGuardEvaluator,
} from "../src/application/services/command-guard-evaluator.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import { TerminalInteractionService, type TerminalInteractionRequest } from "../src/application/services/terminal-interaction-service.ts";
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
		sandbox: terminalTestSandbox,
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

function submitRequest(terminalSessionId: string, toolCallId: string): TerminalInteractionRequest {
	return {
		sessionId: "session-1", terminalSessionId, agentRunId: "run-1", toolCallId,
		action: { type: "submit", input: "echo approved" }, expectation: "finite",
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
			expect(context.repository.findInteractionByToolCall("run-1", "tool-2")).toMatchObject({
				status: "rejected", failure: { code: "guard_blocked" },
				guardDecision: { allowed: false, guardRevision: 2, matchedRuleId: "rule-1", reason: "blocked after approval" },
			});
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

	it("keeps approval pending and uses the persisted input after approval, with idempotent execution", async () => {
		const guards = { evaluate: vi.fn(async () => ({ allowed: true, guardRevision: 1 })) };
		const context = await setup(guards);
		try {
			const request = submitRequest(context.terminal.id, "approved-input");
			await context.interactions.preflightSubmit(request, true);
			await expect(context.interactions.execute(request)).rejects.toMatchObject({ code: "terminal_approval_required" });
			expect(context.repository.findInteractionByToolCall("run-1", request.toolCallId)?.status).toBe("awaiting_approval");
			expect(context.broker.handle?.written).toEqual([]);
			context.interactions.approve("run-1", request.toolCallId);
			const handle = context.broker.handle!;
			const write = handle.write.bind(handle);
			vi.spyOn(handle, "write").mockImplementation(async (bytes) => {
				const interaction = context.repository.findInteractionByToolCall("run-1", request.toolCallId)!;
				expect(interaction.status).toBe("writing");
				expect(context.repository.findInputByInteraction(interaction.id)?.status).toBe("prepared");
				await write(bytes);
			});
			const result = await context.interactions.execute({ ...request, action: { type: "submit", input: "changed after approval" } });
			expect(guards.evaluate).toHaveBeenLastCalledWith("workspace-1", "echo approved");
			expect(new TextDecoder().decode(handle.written[0])).toBe("echo approved\r");
			const repeated = await context.interactions.execute(request);
			expect(repeated.observation.id).toBe(result.observation.id);
			expect(handle.written).toHaveLength(1);
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});

	it.each(["before_execute", "during_guard", "after_input_event"] as const)(
		"does not write a cancelled submit at %s", async (stage) => {
			const controller = new AbortController();
			let checks = 0;
			const context = await setup({ evaluate: async () => {
				checks += 1;
				if (checks === 2 && stage === "during_guard") controller.abort();
				return { allowed: true };
			} });
			try {
				const request = submitRequest(context.terminal.id, `cancel-${stage}`);
				await context.interactions.preflightSubmit(request, false);
				if (stage === "before_execute") controller.abort();
				if (stage === "after_input_event") {
					const actor = context.terminals.getActor("session-1")!;
					const recordEvent = actor.recordDurableEvent.bind(actor);
					vi.spyOn(actor, "recordDurableEvent").mockImplementation(async (type, data) => {
						const sequence = await recordEvent(type, data);
						if (type === "terminal.input") controller.abort();
						return sequence;
					});
				}
				await expect(context.interactions.execute(request, controller.signal)).rejects.toMatchObject({ name: "TerminalObservationCancelledError" });
				expect(context.broker.handle?.written).toEqual([]);
				const interaction = context.repository.findInteractionByToolCall("run-1", request.toolCallId)!;
				expect(interaction).toMatchObject({ status: "cancelled", failure: { code: "run_cancelled" } });
				expect(context.repository.findInputByInteraction(interaction.id)?.status).toBe("prepared");
			} finally {
				await context.terminals.shutdown();
				context.database.close();
			}
		},
	);

	it.each(["channel_write", "input_persistence"] as const)(
		"marks attempted input uncertain after %s fails and never repeats the write", async (failure) => {
			const context = await setup(new Decisions([]));
			try {
				const request = submitRequest(context.terminal.id, `uncertain-${failure}`);
				await context.interactions.preflightSubmit(request, false);
				const handle = context.broker.handle!;
				if (failure === "channel_write") {
					vi.spyOn(handle, "write").mockImplementationOnce(async (bytes) => {
						handle.written.push(bytes.slice());
						throw new Error("channel acknowledgement lost");
					});
				} else vi.spyOn(context.repository, "updateInputStatus").mockReturnValueOnce(false);
				await expect(context.interactions.execute(request)).rejects.toThrow();
				const interaction = context.repository.findInteractionByToolCall("run-1", request.toolCallId)!;
				expect(interaction).toMatchObject({ status: "write_uncertain", failure: { code: "terminal_write_uncertain" } });
				expect(context.repository.findInputByInteraction(interaction.id)).toMatchObject({ status: "uncertain", terminalSequence: expect.any(Number) });
				await expect(context.interactions.execute(request)).rejects.toMatchObject({ code: "terminal_interaction_write_uncertain" });
				expect(handle.written).toHaveLength(1);
			} finally {
				await context.terminals.shutdown();
				context.database.close();
			}
		},
	);

	it("does not write when the writing transition cannot be persisted", async () => {
		const context = await setup(new Decisions([]));
		try {
			const request = submitRequest(context.terminal.id, "writing-persistence");
			await context.interactions.preflightSubmit(request, false);
			vi.spyOn(context.repository, "updateInteraction").mockReturnValueOnce(false);
			await expect(context.interactions.execute(request)).rejects.toMatchObject({ code: "terminal_persistence_failed" });
			expect(context.broker.handle?.written).toEqual([]);
			expect(context.repository.findInteractionByToolCall("run-1", request.toolCallId)?.status).toBe("failed");
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});

	it("settles an observation persistence failure without replaying input or advancing the delivered cursor", async () => {
		const context = await setup(new Decisions([]));
		try {
			const request = submitRequest(context.terminal.id, "observation-persistence");
			await context.interactions.preflightSubmit(request, false);
			vi.spyOn(context.repository, "insertObservation").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
			await expect(context.interactions.execute(request)).rejects.toThrow("storage unavailable");
			expect(context.repository.findInteractionByToolCall("run-1", request.toolCallId)?.status).toBe("failed");
			await expect(context.interactions.execute(request)).rejects.toMatchObject({ code: "terminal_interaction_failed" });
			const next = await context.interactions.execute({ ...request, toolCallId: "unread-after-failure", action: { type: "observe" } });
			expect(next.observation.agentViewText).toContain("result");
			expect(context.broker.handle?.written).toHaveLength(1);
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});

	it("shares an in-flight retry, rejects competing interactions and releases the slot after completion", async () => {
		const context = await setup(new Decisions([]));
		try {
			const request = submitRequest(context.terminal.id, "in-flight");
			await context.interactions.preflightSubmit(request, false);
			let release: () => void = () => undefined;
			let entered: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const writing = new Promise<void>((resolve) => { entered = resolve; });
			const handle = context.broker.handle!;
			const write = handle.write.bind(handle);
			vi.spyOn(handle, "write").mockImplementationOnce(async (bytes) => { entered(); await gate; await write(bytes); });
			const first = context.interactions.execute(request);
			expect(context.interactions.execute(request)).toBe(first);
			await writing;
			const competing = { ...request, toolCallId: "competing", action: { type: "observe" as const } };
			await expect(context.interactions.execute(competing)).rejects.toMatchObject({ code: "terminal_interaction_busy" });
			release();
			await first;
			await expect(context.interactions.execute(competing)).resolves.toMatchObject({ interaction: { status: "completed" } });
			expect(handle.written).toHaveLength(1);
		} finally {
			await context.terminals.shutdown();
			context.database.close();
		}
	});
});
