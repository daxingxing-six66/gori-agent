import { randomUUID } from "node:crypto";

type TransactionPhase = "queued" | "begin" | "operation" | "awaiting_operation" | "commit" | "rollback";
export type TransactionResult = "committed" | "rolled_back" | "begin_failed" | "rollback_failed";

export interface SqliteTransactionDiagnostic {
	event: "sqlite.transaction.blocked" | "sqlite.transaction.slow" | "sqlite.transaction.finished";
	processId: number;
	connectionId: string;
	transactionId: number;
	sourceStack: string;
	phase: TransactionPhase;
	enqueuedAt: number;
	startedAt: number;
	waitMs: number;
	heldMs: number;
	phaseMs: number;
	queueDepth: number;
	blockedAccesses: number;
	access?: { boundary: string; sourceStack: string };
	result?: TransactionResult;
	failurePhase?: TransactionPhase;
}

export interface SqliteTransactionDiagnosticsOptions {
	log?: (record: SqliteTransactionDiagnostic) => void;
	slowThresholdMs?: number;
	monotonicNow?: () => number;
	wallNow?: () => number;
}

interface TransactionTrace {
	id: number;
	sourceStack: string;
	enqueuedAt: number;
	enqueuedTick: number;
	startedAt: number;
	startedTick: number;
	phase: TransactionPhase;
	phaseTick: number;
	blockedAccesses: number;
	reportedAccesses: Set<string>;
	failurePhase?: TransactionPhase;
	slowTimer?: ReturnType<typeof setTimeout>;
}

/** Diagnostic state is separate from ownership: it never grants access, retries SQL, or catches business errors. */
export class SqliteTransactionDiagnostics {
	readonly #connectionId = randomUUID();
	readonly #options: SqliteTransactionDiagnosticsOptions;
	readonly #slowThresholdMs: number;
	#sequence = 0;
	#queueDepth = 0;
	#active: TransactionTrace | undefined;

	constructor(options: SqliteTransactionDiagnosticsOptions = {}) {
		this.#options = options;
		this.#slowThresholdMs = options.slowThresholdMs ?? 1_000;
		if (!Number.isFinite(this.#slowThresholdMs) || this.#slowThresholdMs <= 0) throw new Error("Invalid SQLite diagnostic threshold");
	}

	queued(): TransactionTrace {
		this.#queueDepth++;
		const tick = this.#now();
		return { id: ++this.#sequence, sourceStack: sourceStack(), enqueuedAt: this.#wallNow(), enqueuedTick: tick,
			startedAt: 0, startedTick: tick, phase: "queued", phaseTick: tick, blockedAccesses: 0, reportedAccesses: new Set() };
	}

	started(trace: TransactionTrace): void {
		this.#queueDepth--;
		trace.startedAt = this.#wallNow();
		trace.startedTick = this.#now();
		this.#active = trace;
		this.phase(trace, "begin");
	}

	phase(trace: TransactionTrace, phase: TransactionPhase): void {
		trace.phase = phase;
		trace.phaseTick = this.#now();
		if (phase === "awaiting_operation") {
			trace.slowTimer = setTimeout(() => this.#write(this.#record(trace, "sqlite.transaction.slow")), this.#slowThresholdMs);
			trace.slowTimer.unref();
		}
	}

	failed(trace: TransactionTrace): void { trace.failurePhase = trace.phase; }

	blocked(boundary: string): void {
		const trace = this.#active;
		if (!trace) return;
		trace.blockedAccesses++;
		const access = { boundary, sourceStack: sourceStack() };
		const key = `${boundary}\n${access.sourceStack}`;
		// Retain distinct callers (e.g. metrics and idle scanning) without repeating a burst's full stacks.
		if (trace.reportedAccesses.has(key) || trace.reportedAccesses.size >= 8) return;
		trace.reportedAccesses.add(key);
		this.#write({ ...this.#record(trace, "sqlite.transaction.blocked"), access });
	}

	finished(trace: TransactionTrace, result: TransactionResult): void {
		clearTimeout(trace.slowTimer);
		const record = this.#record(trace, "sqlite.transaction.finished");
		if (trace.blockedAccesses > 0 || record.heldMs >= this.#slowThresholdMs || record.waitMs >= this.#slowThresholdMs) {
			this.#write({ ...record, result, ...(trace.failurePhase ? { failurePhase: trace.failurePhase } : {}) });
		}
		if (this.#active === trace) this.#active = undefined;
	}

	#record(trace: TransactionTrace, event: SqliteTransactionDiagnostic["event"]): SqliteTransactionDiagnostic {
		const now = this.#now();
		return { event, processId: process.pid, connectionId: this.#connectionId, transactionId: trace.id,
			sourceStack: trace.sourceStack, phase: trace.phase, enqueuedAt: trace.enqueuedAt, startedAt: trace.startedAt,
			waitMs: Math.max(0, trace.startedTick - trace.enqueuedTick), heldMs: Math.max(0, now - trace.startedTick),
			phaseMs: Math.max(0, now - trace.phaseTick), queueDepth: this.#queueDepth, blockedAccesses: trace.blockedAccesses };
	}

	#now(): number { return this.#options.monotonicNow?.() ?? performance.now(); }
	#wallNow(): number { return this.#options.wallNow?.() ?? Date.now(); }
	#write(record: SqliteTransactionDiagnostic): void {
		try {
			if (this.#options.log) this.#options.log(record);
			else if (record.event === "sqlite.transaction.blocked") console.error("SSH Agent SQLite transaction diagnostic", record);
			else console.info("SSH Agent SQLite transaction diagnostic", record);
		} catch {
			// Observability must not replace the original failure or interfere with commit/rollback and queue release.
		}
	}
}

function sourceStack(): string {
	return (new Error("SQLite diagnostic callsite").stack ?? "").split("\n").slice(1)
		.filter((line) => !/[/\\]sqlite-transaction-(?:diagnostics|runner)\.(?:ts|js):/.test(line))
		.slice(0, 12).join("\n");
}
