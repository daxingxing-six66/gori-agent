export interface ChatPromptSnapshot {
	readonly sessionId: string;
	readonly systemPrompt: string;
	readonly version: number;
	readonly createdAt: number;
}

/** Snapshots are insert-only; concurrent initialization returns the stored winner. */
export interface ChatPromptRepository {
	find(sessionId: string): ChatPromptSnapshot | undefined;
	createOnce(snapshot: ChatPromptSnapshot): ChatPromptSnapshot;
}
