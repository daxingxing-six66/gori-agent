import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { TransactionRunner } from "../../application/transaction-runner.ts";

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

	constructor(database: DatabaseSync) {
		this.database = database;
		this.guardConnection();
	}

	async run<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.activeOwner !== undefined && this.ownerContext.getStore() === this.activeOwner) {
			throw new Error("Nested SQLite transactions are not supported");
		}
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
				try {
					this.database.exec("BEGIN IMMEDIATE");
					try {
						const result = operation();
						const value = result instanceof Promise ? await result : result;
						this.database.exec("COMMIT");
						return value;
					} catch (error) {
						this.database.exec("ROLLBACK");
						throw error;
					}
				} finally {
					this.activeOwner = undefined;
				}
			});
		} finally {
			releaseTransaction();
		}
	}

	private guardConnection(): void {
		const originalPrepare = this.database.prepare.bind(this.database);
		this.database.prepare = (sql) => {
			this.requireOwner();
			return this.guardStatement(originalPrepare(sql));
		};
		const originalExec = this.database.exec.bind(this.database);
		this.database.exec = (sql) => {
			this.requireOwner();
			originalExec(sql);
		};

		// setAuthorizer is available on newer Node runtimes. It also catches database APIs
		// that bypass prepare()/exec(); the wrappers above cover the supported Node 22 runtime.
		const authorizerDatabase = this.database as DatabaseSync & {
			setAuthorizer?: (authorizer: (actionCode: number) => number) => void;
		};
		authorizerDatabase.setAuthorizer?.(() =>
			this.activeOwner !== undefined && this.ownerContext.getStore() !== this.activeOwner ? 1 : 0,
		);
	}

	private guardStatement(statement: StatementSync): StatementSync {
		return new Proxy(statement, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					this.requireOwner();
					const result: unknown = Reflect.apply(value, target, args);
					if (property !== "iterate" || result === null || typeof result !== "object") return result;
					const guardedIterator = new Proxy(result, {
						get: (iterator, iteratorProperty) => {
							if (iteratorProperty === Symbol.iterator) return () => guardedIterator;
							const iteratorValue = Reflect.get(iterator, iteratorProperty, iterator);
							if (typeof iteratorValue !== "function") return iteratorValue;
							return (...iteratorArgs: unknown[]) => {
								this.requireOwner();
								return Reflect.apply(iteratorValue, iterator, iteratorArgs);
							};
						},
					});
					return guardedIterator;
				};
			},
		});
	}

	private requireOwner(): void {
		if (this.activeOwner !== undefined && this.ownerContext.getStore() !== this.activeOwner) {
			throw new SqliteTransactionBusyError();
		}
	}
}
