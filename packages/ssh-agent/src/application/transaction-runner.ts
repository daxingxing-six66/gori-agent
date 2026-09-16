export interface TransactionRunner {
	run<T>(operation: () => Promise<T>): Promise<T>;
}
