import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
	SqliteTransactionBusyError,
	SqliteTransactionRunner,
} from "../src/infrastructure/sqlite/sqlite-transaction-runner.ts";

type DiagnosticOptions = NonNullable<ConstructorParameters<typeof SqliteTransactionRunner>[1]>;
type DiagnosticRecord = Parameters<NonNullable<DiagnosticOptions["log"]>>[0];

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function createDatabase(): DatabaseSync {
	const database = new DatabaseSync(":memory:");
	database.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT)");
	return database;
}

describe("SQLite transaction diagnostics", () => {
	it("attributes blocked accesses to the active owner while another transaction is queued", async () => {
		const database = createDatabase();
		const records: DiagnosticRecord[] = [];
		let monotonic = 100;
		let wall = 10_000;
		const transactions = new SqliteTransactionRunner(database, {
			log: (record) => records.push(record), monotonicNow: () => monotonic, wallNow: () => wall,
		});
		const enteredA = deferred();
		const releaseA = deferred();
		const enteredB = deferred();
		const releaseB = deferred();
		const ownerReads: unknown[] = [];
		function ownerTransactionA(): Promise<void> {
			return transactions.run(async () => {
				database.prepare("INSERT INTO events (id) VALUES (1)").run();
				enteredA.resolve();
				await releaseA.promise;
				ownerReads.push(database.prepare("SELECT id FROM events ORDER BY id").all());
			});
		}
		function ownerTransactionB(): Promise<void> {
			return transactions.run(async () => {
				database.prepare("INSERT INTO events (id) VALUES (2)").run();
				enteredB.resolve();
				await releaseB.promise;
				ownerReads.push(database.prepare("SELECT id FROM events ORDER BY id").all());
			});
		}
		function blockedReadFromIdleScan(): unknown {
			return database.prepare("SELECT id FROM events").all();
		}
		const first = ownerTransactionA();
		let second: Promise<void> | undefined;
		try {
			await enteredA.promise;
			monotonic = 125;
			wall = 10_025;
			second = ownerTransactionB();
			monotonic = 150;
			wall = 10_050;
			expect(blockedReadFromIdleScan).toThrow(SqliteTransactionBusyError);
			const blockedA = records.find((record) => record.event === "sqlite.transaction.blocked");
			expect(blockedA).toMatchObject({
				processId: process.pid, phase: "awaiting_operation", enqueuedAt: 10_000, startedAt: 10_000,
				waitMs: 0, heldMs: 50, phaseMs: 50, blockedAccesses: 1,
				connectionId: expect.any(String), transactionId: expect.any(Number),
				access: { boundary: expect.any(String), sourceStack: expect.stringContaining("blockedReadFromIdleScan") },
			});
			expect(blockedA?.sourceStack).toContain("ownerTransactionA");
			expect(blockedA?.queueDepth).toBeGreaterThanOrEqual(1);

			monotonic = 175;
			wall = 10_075;
			releaseA.resolve();
			await first;
			await enteredB.promise;
			monotonic = 200;
			wall = 10_100;
			expect(blockedReadFromIdleScan).toThrow(SqliteTransactionBusyError);
			const blockedB = records.filter((record) => record.event === "sqlite.transaction.blocked")[1];
			expect(blockedB).toMatchObject({
				connectionId: blockedA?.connectionId, phase: "awaiting_operation", enqueuedAt: 10_025,
				startedAt: 10_075, waitMs: 50, heldMs: 25, blockedAccesses: 1,
			});
			expect(blockedB?.sourceStack).toContain("ownerTransactionB");
			expect(blockedB?.transactionId).not.toBe(blockedA?.transactionId);
			releaseB.resolve();
			await second;
			expect(ownerReads).toEqual([[{ id: 1 }], [{ id: 1 }, { id: 2 }]]);
			expect(records.filter((record) => record.event === "sqlite.transaction.finished")).toEqual([
				expect.objectContaining({ transactionId: blockedA?.transactionId, result: "committed", blockedAccesses: 1 }),
				expect.objectContaining({ transactionId: blockedB?.transactionId, result: "committed", blockedAccesses: 1 }),
			]);
			expect(database.prepare("SELECT id FROM events ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
		} finally {
			releaseA.resolve();
			releaseB.resolve();
			await Promise.allSettled([first, second]);
			database.close();
		}
	});

	it("identifies database, precompiled statement, and iterator access boundaries without executing them", async () => {
		const database = createDatabase();
		const records: DiagnosticRecord[] = [];
		const transactions = new SqliteTransactionRunner(database, { log: (record) => records.push(record) });
		database.prepare("INSERT INTO events (id) VALUES (1)").run();
		const statement = database.prepare("SELECT id FROM events");
		const iterator = statement.iterate();
		const entered = deferred();
		const release = deferred();
		const transaction = transactions.run(async () => { entered.resolve(); await release.promise; });
		try {
			await entered.promise;
			expect(() => database.prepare("SELECT 1")).toThrow(SqliteTransactionBusyError);
			expect(() => database.exec("DELETE FROM events")).toThrow(SqliteTransactionBusyError);
			expect(() => statement.get()).toThrow(SqliteTransactionBusyError);
			expect(() => iterator.next()).toThrow(SqliteTransactionBusyError);
			const blocked = records.filter((record) => record.event === "sqlite.transaction.blocked");
			expect(blocked).toHaveLength(4);
			expect(new Set(blocked.map((record) => record.access?.boundary)).size).toBe(4);
			release.resolve();
			await transaction;
			expect(database.prepare("SELECT id FROM events").all()).toEqual([{ id: 1 }]);
			expect(iterator.next()).toMatchObject({ value: { id: 1 }, done: false });
		} finally {
			release.resolve();
			await transaction;
			iterator.return?.();
			database.close();
		}
	});

	it("retains the original operation error after rollback and omits SQL, parameters, and error contents from diagnostics", async () => {
		const database = createDatabase();
		const records: DiagnosticRecord[] = [];
		const transactions = new SqliteTransactionRunner(database, { log: (record) => records.push(record) });
		const entered = deferred();
		const release = deferred();
		const original = new Error("PRIVATE_ERROR_CONTENT_SENTINEL");
		const transaction = transactions.run(async () => {
			database.prepare("INSERT INTO events (id, value) VALUES (1, ?)").run("PRIVATE_PARAMETER_SENTINEL");
			entered.resolve();
			await release.promise;
			throw original;
		});
		try {
			await entered.promise;
			expect(() => database.prepare("SELECT 'PRIVATE_SQL_SENTINEL'").get()).toThrow(SqliteTransactionBusyError);
			release.resolve();
			await expect(transaction).rejects.toBe(original);
			expect(database.prepare("SELECT * FROM events").all()).toEqual([]);
			expect(records).toEqual(expect.arrayContaining([
				expect.objectContaining({ event: "sqlite.transaction.blocked" }),
				expect.objectContaining({ event: "sqlite.transaction.finished", result: "rolled_back" }),
			]));
			const serialized = JSON.stringify(records);
			for (const secret of ["PRIVATE_ERROR_CONTENT_SENTINEL", "PRIVATE_PARAMETER_SENTINEL", "PRIVATE_SQL_SENTINEL", "INSERT INTO events", "SELECT '"]) {
				expect(serialized).not.toContain(secret);
			}
			await transactions.run(() => database.prepare("INSERT INTO events (id) VALUES (2)").run());
			expect(database.prepare("SELECT id FROM events").all()).toEqual([{ id: 2 }]);
		} finally {
			release.resolve();
			await Promise.allSettled([transaction]);
			database.close();
		}
	});

	it("preserves busy and operation errors when the logger throws and releases queued transactions", async () => {
		const database = createDatabase();
		const logger = vi.fn(() => { throw new Error("logger failed"); });
		const transactions = new SqliteTransactionRunner(database, { log: logger });
		const entered = deferred();
		const release = deferred();
		const original = new Error("operation failed");
		const transaction = transactions.run(async () => {
			database.prepare("INSERT INTO events (id) VALUES (1)").run();
			entered.resolve();
			await release.promise;
			throw original;
		});
		let queued: Promise<unknown> | undefined;
		try {
			await entered.promise;
			queued = transactions.run(() => database.prepare("INSERT INTO events (id) VALUES (2)").run());
			expect(() => database.prepare("SELECT id FROM events").all()).toThrow(SqliteTransactionBusyError);
			release.resolve();
			await expect(transaction).rejects.toBe(original);
			await queued;
			expect(logger).toHaveBeenCalled();
			expect(database.prepare("SELECT id FROM events").all()).toEqual([{ id: 2 }]);
		} finally {
			release.resolve();
			await Promise.allSettled([transaction, queued]);
			database.close();
		}
	});

	it("bounds distinct and duplicate blocked logs while retaining the total access count on completion", async () => {
		const database = createDatabase();
		const records: DiagnosticRecord[] = [];
		const transactions = new SqliteTransactionRunner(database, { log: (record) => records.push(record) });
		const entered = deferred();
		const release = deferred();
		const transaction = transactions.run(async () => { entered.resolve(); await release.promise; });
		try {
			await entered.promise;
			const differentCallsites = [
				() => database.exec("SELECT 1"),
				() => database.exec("SELECT 2"),
				() => database.exec("SELECT 3"),
				() => database.exec("SELECT 4"),
				() => database.exec("SELECT 5"),
				() => database.exec("SELECT 6"),
				() => database.exec("SELECT 7"),
				() => database.exec("SELECT 8"),
				() => database.exec("SELECT 9"),
				() => database.exec("SELECT 10"),
			];
			for (const access of differentCallsites) expect(access).toThrow(SqliteTransactionBusyError);
			for (let index = 0; index < 20; index += 1) {
				expect(() => database.exec("SELECT 1")).toThrow(SqliteTransactionBusyError);
			}
			const blocked = records.filter((record) => record.event === "sqlite.transaction.blocked");
			expect(blocked).toHaveLength(8);
			release.resolve();
			await transaction;
			expect(records).toContainEqual(expect.objectContaining({ event: "sqlite.transaction.finished", blockedAccesses: 30 }));
		} finally {
			release.resolve();
			await transaction;
			database.close();
		}
	});

	it("reports an asynchronous slow owner with an unreferenced timer and clears timers after completion", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const timerSpy = vi.spyOn(globalThis, "setTimeout");
		const database = createDatabase();
		const records: DiagnosticRecord[] = [];
		let monotonic = 0;
		const transactions = new SqliteTransactionRunner(database, {
			log: (record) => records.push(record), slowThresholdMs: 1000, monotonicNow: () => monotonic,
		});
		const entered = deferred();
		const release = deferred();
		const transaction = transactions.run(async () => { entered.resolve(); await release.promise; });
		try {
			await entered.promise;
			expect(vi.getTimerCount()).toBe(1);
			const timer = timerSpy.mock.results[0]?.value as ReturnType<typeof setTimeout> | undefined;
			expect(timer?.hasRef()).toBe(false);
			monotonic = 1000;
			await vi.advanceTimersByTimeAsync(1000);
			expect(records).toContainEqual(expect.objectContaining({
				event: "sqlite.transaction.slow", phase: "awaiting_operation", heldMs: 1000, blockedAccesses: 0,
			}));
			monotonic = 1500;
			release.resolve();
			await transaction;
			expect(records).toContainEqual(expect.objectContaining({ event: "sqlite.transaction.finished", result: "committed", heldMs: 1500 }));
			expect(vi.getTimerCount()).toBe(0);
			const earlyRelease = deferred();
			const earlyEntered = deferred();
			const early = transactions.run(async () => { earlyEntered.resolve(); await earlyRelease.promise; });
			await earlyEntered.promise;
			expect(vi.getTimerCount()).toBe(1);
			monotonic = 1600;
			earlyRelease.resolve();
			await early;
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(2000);
			expect(records.filter((record) => record.event === "sqlite.transaction.slow")).toHaveLength(1);
			expect(records.filter((record) => record.event === "sqlite.transaction.finished")).toHaveLength(1);
		} finally {
			release.resolve();
			await Promise.allSettled([transaction]);
			database.close();
			timerSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});
