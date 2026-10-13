import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { TerminalInteraction, TerminalObservation, TerminalSession } from "../src/domain/terminal.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";

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

const terminalSession = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
	id: "terminal-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	openRequestId: "open-1",
	closeRequestId: null,
	status: "opening",
	requestedSandboxMode: null,
	sandbox: null,
	revision: 1,
	geometry: { rows: 36, cols: 120 },
	eventSequence: 0,
	ownershipEpoch: 0,
	connectionGeneration: null,
	term: "xterm-256color",
	activatedAt: null,
	lastConsumerActivityAt: 10,
	idleDeadlineAt: null,
	closingAt: null,
	closedAt: null,
	closeReason: null,
	failureCode: null,
	failureMessage: null,
	createdAt: 10,
	updatedAt: 10,
	...overrides,
});

const insertChatRun = (database: DatabaseSync): void => {
	database
		.prepare(`INSERT INTO chat_runs (
			id, session_id, workspace_id, request_id, provider_id, model_id, thinking_level,
			status, created_at, updated_at, server_interaction_mode, terminal_session_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			"run-1",
			"session-1",
			"workspace-1",
			"run-request-1",
			"provider",
			"model",
			"off",
			"running",
			10,
			10,
			"terminal",
			"terminal-1",
		);
};

const terminalInteraction = (overrides: Partial<TerminalInteraction> = {}): TerminalInteraction => ({
	id: "interaction-1",
	terminalSessionId: "terminal-1",
	sessionId: "session-1",
	agentRunId: "run-1",
	toolCallId: "tool-call-1",
	action: { type: "submit" },
	expectation: "finite",
	status: "prepared",
	inputSequence: null,
	observationId: null,
	guardDecision: null,
	approvalRequired: true,
	failure: null,
	createdAt: 11,
	updatedAt: 11,
	completedAt: null,
	...overrides,
});

describe("SqliteTerminalRepository", () => {
	it.each([
		{ mode: "full_access", backend: "none", enforcement: "none", approvedAt: 10, extra: true },
		{ mode: "full_access", backend: "none", enforcement: "none", source: "landlock_unavailable", detectedAt: 10, approvedAt: 10 },
		{ mode: "full_access", backend: "landlock", enforcement: "full", approvedAt: 10 },
		{ mode: "workspace_write", backend: "bubblewrap", enforcement: "full", bubblewrapVersion: "0.12.0", sandboxRoot: "/opt/app", approvedAt: 10 },
	])("rejects mixed historical and current sandbox facts: %j", (facts) => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession({ status: "closed" }));
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'").run(JSON.stringify(facts));
			expect(() => repository.findSession("terminal-1")).toThrow("Invalid persisted Terminal sandbox facts");
		} finally { database.close(); }
	});

	it("does not let historical compatibility bypass opening and active session invariants", () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession());
			database.prepare("UPDATE terminal_sessions SET requested_sandbox_mode = 'workspace_write', sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "full_access", backend: "none", enforcement: "none", source: "landlock_unavailable", detectedAt: 10 }));
			expect(() => repository.findSession("terminal-1")).toThrow("Opening Terminal cannot claim an active sandbox");
			database.prepare("UPDATE terminal_sessions SET status = 'active', sandbox_json = NULL WHERE id = 'terminal-1'").run();
			expect(() => repository.findSession("terminal-1")).toThrow("Active Terminal sandbox facts are missing");
		} finally { database.close(); }
	});

	it("enforces one live TerminalSession per business Session and performs status/revision CAS", () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession());
			expect(() =>
				repository.insertSession(terminalSession({ id: "terminal-2", openRequestId: "open-2" })),
			).toThrow();

			const active = terminalSession({
				status: "active",
				revision: 2,
				connectionGeneration: 3,
				activatedAt: 20,
				updatedAt: 20,
			});
			expect(repository.updateSession(active, "opening", 1)).toBe(true);
			expect(repository.updateSession({ ...active, revision: 3 }, "opening", 1)).toBe(false);
			expect(repository.findCurrentSession("session-1")).toEqual(active);
		} finally {
			database.close();
		}
	});

	it("persists exact dispatch bytes and immutable Observation text", () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession({ status: "active" }));
			insertChatRun(database);
			repository.insertInteraction(terminalInteraction());
			const encodedBytes = new TextEncoder().encode("printf '你好'\r");
			repository.insertInput({
				id: "input-1",
				interactionId: "interaction-1",
				terminalSessionId: "terminal-1",
				displayText: "printf '你好'",
				inputKind: "submit",
				encodedBytes,
				byteLength: encodedBytes.byteLength,
				status: "prepared",
				terminalSequence: null,
				guardRevision: 4,
				matchedGuardRuleId: null,
				createdAt: 12,
				writtenAt: null,
			});
			const observation: TerminalObservation = {
				id: "observation-1",
				interactionId: "interaction-1",
				terminalSessionId: "terminal-1",
				startSequence: 7,
				endSequence: 9,
				kind: "transcript",
				geometry: { rows: 36, cols: 120 },
				boundaryReason: "quiet",
				agentViewText: "不可变的 Agent 视图",
				rawByteCount: 42,
				truncated: false,
				capturedAt: 13,
				deliveredAt: null,
				processingAt: null,
				finishedAt: null,
			};
			repository.insertObservation(observation);

			expect(repository.findInputByInteraction("interaction-1")).toMatchObject({
				displayText: "printf '你好'",
				encodedBytes,
			});
			expect(repository.findObservation("observation-1")).toEqual(observation);
			expect(repository.findInteraction("interaction-1")?.observationId).toBe("observation-1");
		} finally {
			database.close();
		}
	});

	it("recovers interrupted sessions and distinguishes uncertain writes", () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession({ status: "active" }));
			insertChatRun(database);
			repository.insertInteraction(terminalInteraction({ status: "writing" }));

			repository.recoverInterrupted(100);

			expect(repository.findSession("terminal-1")).toMatchObject({
				status: "lost",
				closeReason: "backend_restarted",
				closedAt: 100,
			});
			expect(repository.findInteraction("interaction-1")).toMatchObject({
				status: "write_uncertain",
				failure: { code: "backend_restarted" },
			});
		} finally {
			database.close();
		}
	});

	it("rejects malformed persisted interaction action JSON", () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession({ status: "active" }));
			insertChatRun(database);
			repository.insertInteraction(terminalInteraction());
			database
				.prepare("UPDATE terminal_interactions SET action_json = ? WHERE id = ?")
				.run(JSON.stringify({ type: "key", key: "CTRL_Z" }), "interaction-1");

			expect(() => repository.findInteraction("interaction-1")).toThrow(
				"Invalid persisted Terminal interaction action",
			);
		} finally {
			database.close();
		}
	});

	it("validates persisted Guard decisions at the SQLite boundary", () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession({ status: "active" }));
			insertChatRun(database);
			repository.insertInteraction(
				terminalInteraction({
					guardDecision: {
						allowed: true,
						guardRevision: 4,
						matchedRuleId: null,
						reason: null,
					},
				}),
			);
			expect(repository.findInteraction("interaction-1")?.guardDecision).toEqual({
				allowed: true,
				guardRevision: 4,
				matchedRuleId: null,
				reason: null,
			});

			database
				.prepare("UPDATE terminal_interactions SET guard_decision_json = ? WHERE id = ?")
				.run(JSON.stringify({ allowed: true }), "interaction-1");
			expect(() => repository.findInteraction("interaction-1")).toThrow("Invalid persisted Terminal Guard decision");
		} finally {
			database.close();
		}
	});

	it("keeps legacy Terminal facts unknown and rejects corrupted sandbox claims", () => {
		const database = createDatabase();
		try {
			const repository = new SqliteTerminalRepository(database);
			repository.insertSession(terminalSession({ status: "closed" }));
			expect(repository.findSession("terminal-1")).toMatchObject({ requestedSandboxMode: null, sandbox: null });
			database.prepare("UPDATE terminal_sessions SET requested_sandbox_mode = 'workspace_write', sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "full_access", backend: "none", enforcement: "none", approvedAt: 10 }));
			expect(() => repository.findSession("terminal-1")).toThrow("Invalid persisted Terminal sandbox mode");
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "full_access", backend: "none", enforcement: "none", source: "landlock_unavailable", detectedAt: 10 }));
			expect(repository.findSession("terminal-1")?.sandbox).toMatchObject({ mode: "full_access", source: "landlock_unavailable" });
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "full_access", backend: "none", enforcement: "none", source: "sandbox_unavailable", detectedAt: 10 }));
			expect(repository.findSession("terminal-1")?.sandbox).toMatchObject({ mode: "full_access", source: "sandbox_unavailable" });
			database.prepare("UPDATE terminal_sessions SET requested_sandbox_mode = 'full_access', sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "full_access", backend: "none", enforcement: "none", approvedAt: 10 }));
			expect(repository.findSession("terminal-1")?.sandbox).toEqual({ mode: "full_access", backend: "none", enforcement: "none", approvedAt: 10 });
			database.prepare("UPDATE terminal_sessions SET requested_sandbox_mode = 'workspace_write', sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5,
					launcherVersion: "3", sandboxRoot: "/opt/app" }));
			expect(repository.findSession("terminal-1")?.sandbox).toEqual({ mode: "workspace_write", backend: "landlock", enforcement: "full",
				abi: 5, launcherVersion: "3", sandboxRoot: "/opt/app" });
			const bubblewrap = { mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
				bubblewrapVersion: "0.12.0", sandboxRoot: "/opt/app" };
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify(bubblewrap));
			expect(repository.findSession("terminal-1")?.sandbox).toEqual(bubblewrap);
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ ...bubblewrap, abi: 5 }));
			expect(() => repository.findSession("terminal-1")).toThrow("Invalid persisted Terminal sandbox facts");
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5,
					launcherVersion: "3", sandboxRoot: "/opt/app/" }));
			expect(() => repository.findSession("terminal-1")).toThrow("Invalid persisted Terminal sandbox facts");
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'")
				.run(JSON.stringify({ mode: "full_access", backend: "none", enforcement: "none", source: "landlock_unavailable", detectedAt: -1 }));
			expect(() => repository.findSession("terminal-1")).toThrow("Invalid persisted Terminal sandbox facts");
			database.prepare("UPDATE terminal_sessions SET sandbox_json = ? WHERE id = 'terminal-1'").run('{bad json');
			expect(() => repository.findSession("terminal-1")).toThrow("Invalid persisted Terminal sandbox JSON");
		} finally { database.close(); }
	});

	it("adds nullable sandbox columns to a v19 Terminal table", () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec("CREATE TABLE ssh_agent_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT");
			const recorded = database.prepare("INSERT INTO ssh_agent_schema_migrations VALUES (?, 1)");
			// Exercise v20 in isolation; later deployment migrations require full historical tables.
			for (let version = 1; version <= 28; version++) if (version !== 20) recorded.run(version);
			database.exec("CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT");
			database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, remote_default_cwd TEXT NOT NULL DEFAULT '/', remote_sandbox_root TEXT) STRICT");
			database.exec("INSERT INTO terminal_sessions VALUES ('legacy', 'closed')");
			applyMigrations(database);
			const row = database.prepare("SELECT requested_sandbox_mode, sandbox_json FROM terminal_sessions WHERE id = 'legacy'").get() as Record<string, unknown>;
			expect(row).toEqual({ requested_sandbox_mode: null, sandbox_json: null });
		} finally { database.close(); }
	});
});
