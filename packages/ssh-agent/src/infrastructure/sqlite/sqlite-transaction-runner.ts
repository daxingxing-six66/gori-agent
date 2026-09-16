import type { DatabaseSync } from "node:sqlite";
import type { TransactionRunner } from "../../application/transaction-runner.ts";

export class SqliteTransactionRunner implements TransactionRunner {
	private readonly database: DatabaseSync;
	private transactionQueue: Promise<void> = Promise.resolve();

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const previousTransaction = this.transactionQueue;
		let releaseTransaction: () => void = () => undefined;
		this.transactionQueue = new Promise<void>((resolve) => {
			releaseTransaction = resolve;
		});
		await previousTransaction;

		try {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				const result = await operation();
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				this.database.exec("ROLLBACK");
				throw error;
			}
		} finally {
			releaseTransaction();
		}
	}
}
