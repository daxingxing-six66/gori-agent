export interface TransactionRunner {
	run<T>(operation: () => T | Promise<T>): Promise<T>;
}
