import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { TransactionRunner } from "../../application/transaction-runner.ts";
import { SqliteTransactionDiagnostics, type SqliteTransactionDiagnosticsOptions, type TransactionResult } from "./sqlite-transaction-diagnostics.ts";

/** A synchronous repository call cannot wait for another request's open transaction. */
export class SqliteTransactionBusyError extends Error {
	constructor() {
		super("SQLite connection is in use by another transaction; retry after it completes");
		this.name = "SqliteTransactionBusyError";
	}
}

export class SqliteTransactionRunner implements TransactionRunner {
	private readonly database: DatabaseSync;
	private readonly ownerContext = new AsyncLocalStorage<symbol>();
	private activeOwner: symbol | undefined;
	private transactionQueue: Promise<void> = Promise.resolve();
	private readonly diagnostics: SqliteTransactionDiagnostics;

	constructor(database: DatabaseSync, diagnostics: SqliteTransactionDiagnosticsOptions = {}) {
		this.database = database;
		this.diagnostics = new SqliteTransactionDiagnostics(diagnostics);
		this.guardConnection();
	}

	async run<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.activeOwner !== undefined && this.ownerContext.getStore() === this.activeOwner) {
			throw new Error("Nested SQLite transactions are not supported");
		}
		const trace = this.diagnostics.queued();
		const previousTransaction = this.transactionQueue;
		let releaseTransaction: () => void = () => undefined;
		this.transactionQueue = new Promise<void>((resolve) => {
			releaseTransaction = resolve;
		});
		await previousTransaction;

		try {
			const owner = Symbol("sqlite-transaction");
			return await this.ownerContext.run(owner, async () => {
				this.activeOwner = owner;
				this.diagnostics.started(trace);
				let outcome: TransactionResult = "begin_failed";
				try {
					this.database.exec("BEGIN IMMEDIATE");
					try {
						this.diagnostics.phase(trace, "operation");
						const result = operation();
						const asynchronous = result instanceof Promise;
						if (asynchronous) this.diagnostics.phase(trace, "awaiting_operation");
						const value = asynchronous ? await result : result;
						this.diagnostics.phase(trace, "commit");
						this.database.exec("COMMIT");
						outcome = "committed";
						return value;
					} catch (error) {
						this.diagnostics.failed(trace);
						this.diagnostics.phase(trace, "rollback");
						outcome = "rollback_failed";
						this.database.exec("ROLLBACK");
						outcome = "rolled_back";
						throw error;
					}
				} finally {
					this.activeOwner = undefined;
					this.diagnostics.finished(trace, outcome);
				}
			});
		} finally {
			releaseTransaction();
		}
	}

	private guardConnection(): void {
		const originalPrepare = this.database.prepare.bind(this.database);
		this.database.prepare = (sql) => {
			this.requireOwner("prepare");
			return this.guardStatement(originalPrepare(sql));
		};
		const originalExec = this.database.exec.bind(this.database);
		this.database.exec = (sql) => {
			this.requireOwner("exec");
			originalExec(sql);
		};

		// setAuthorizer is available on newer Node runtimes. It also catches database APIs
		// that bypass prepare()/exec(); the wrappers above cover the supported Node 22 runtime.
		const authorizerDatabase = this.database as DatabaseSync & {
			setAuthorizer?: (authorizer: (actionCode: number) => number) => void;
		};
		authorizerDatabase.setAuthorizer?.(() => {
			if (this.activeOwner !== undefined && this.ownerContext.getStore() !== this.activeOwner) {
				this.diagnostics.blocked("authorizer");
				return 1;
			}
			return 0;
		});
	}

	private guardStatement(statement: StatementSync): StatementSync {
		return new Proxy(statement, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					this.requireOwner(`statement.${String(property)}`);
					const result: unknown = Reflect.apply(value, target, args);
					if (property !== "iterate" || result === null || typeof result !== "object") return result;
					const guardedIterator = new Proxy(result, {
						get: (iterator, iteratorProperty) => {
							if (iteratorProperty === Symbol.iterator) return () => guardedIterator;
							const iteratorValue = Reflect.get(iterator, iteratorProperty, iterator);
							if (typeof iteratorValue !== "function") return iteratorValue;
							return (...iteratorArgs: unknown[]) => {
									this.requireOwner(`iterator.${String(iteratorProperty)}`);
								return Reflect.apply(iteratorValue, iterator, iteratorArgs);
							};
						},
					});
					return guardedIterator;
				};
			},
		});
	}

	private requireOwner(boundary: string): void {
		if (this.activeOwner !== undefined && this.ownerContext.getStore() !== this.activeOwner) {
			this.diagnostics.blocked(boundary);
			throw new SqliteTransactionBusyError();
		}
	}
}
