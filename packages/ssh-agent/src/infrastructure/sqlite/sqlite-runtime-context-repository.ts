import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeContextRepository } from "../../application/repositories/runtime-context-repository.ts";
import type { TransactionRunner } from "../../application/transaction-runner.ts";
import { canonicalRuntimeJson, runtimeContextMessage, type RuntimeContextMessage, type RuntimeContextSnapshot } from "../../domain/runtime-context.ts";

export class SqliteRuntimeContextRepository implements RuntimeContextRepository {
	private readonly database: DatabaseSync;
	private readonly transactions: TransactionRunner;
	constructor(database: DatabaseSync, transactions: TransactionRunner) { this.database = database; this.transactions = transactions; }
	latest(sessionId: string): RuntimeContextMessage[] {
		return this.database.prepare(`SELECT m.message_json FROM chat_runtime_context_heads h JOIN chat_messages m ON m.id=h.message_id WHERE h.session_id=? ORDER BY m.sequence`).all(sessionId)
			.map(row => JSON.parse(String(row.message_json)) as RuntimeContextMessage);
	}
	async synchronize(sessionId: string, read: () => Promise<RuntimeContextSnapshot[]>): Promise<RuntimeContextMessage[]> {
		return this.transactions.run(async () => {
			const snapshots = await read();
			for (const snapshot of snapshots) {
				const hash = createHash("sha256").update(canonicalRuntimeJson(snapshot)).digest("hex");
				const prior = this.database.prepare("SELECT revision, content_hash FROM chat_runtime_context_heads WHERE session_id=? AND channel=?").get(sessionId, snapshot.channel);
				if (prior?.content_hash === hash) continue;
				const revision = Number(prior?.revision ?? 0) + 1, id = randomUUID(), now = Date.now();
				const message = runtimeContextMessage(snapshot, revision, id, now);
				this.database.prepare(`INSERT INTO chat_messages (id,session_id,run_id,sequence,message_type,message_json,created_at)
					SELECT ?,?,NULL,COALESCE(MAX(sequence),0)+1,'system',?,? FROM chat_messages WHERE session_id=?`).run(id, sessionId, JSON.stringify(message), now, sessionId);
				this.database.prepare(`INSERT INTO chat_runtime_context_heads (session_id,channel,revision,content_hash,message_id) VALUES (?,?,?,?,?)
					ON CONFLICT(session_id,channel) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,message_id=excluded.message_id`).run(sessionId, snapshot.channel, revision, hash, id);
			}
			return this.latest(sessionId);
		});
	}
}
