import type { DatabaseSync } from "node:sqlite";
import type { ChatPromptRepository, ChatPromptSnapshot } from "../../application/repositories/chat-prompt-repository.ts";

export class SqliteChatPromptRepository implements ChatPromptRepository {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	find(sessionId: string): ChatPromptSnapshot | undefined {
		const row = this.#database.prepare("SELECT * FROM chat_prompt_snapshots WHERE session_id = ?").get(sessionId);
		if (!row) return undefined;
		return {
			sessionId: String(row.session_id),
			systemPrompt: String(row.system_prompt),
			version: Number(row.version),
			createdAt: Number(row.created_at),
		};
	}

	createOnce(snapshot: ChatPromptSnapshot): ChatPromptSnapshot {
		// The insert trigger records the initial mode in the same atomic statement.
		this.#database
			.prepare(`INSERT INTO chat_prompt_snapshots
				(session_id, system_prompt, version, created_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(session_id) DO NOTHING`)
			.run(snapshot.sessionId, snapshot.systemPrompt, snapshot.version, snapshot.createdAt);
		const stored = this.find(snapshot.sessionId);
		if (!stored) throw new Error("Chat prompt snapshot was not persisted");
		return stored;
	}
}
