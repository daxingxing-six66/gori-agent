import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteChatPromptRepository } from "../src/infrastructure/sqlite/sqlite-chat-prompt-repository.ts";

function setup(variant: "legacy" | "current") {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	applyMigrations(db);
	db.exec(`DROP TRIGGER chat_prompt_initial_mode; DROP TRIGGER chat_prompt_snapshot_immutable;
		DROP TRIGGER chat_terminal_mode_transition; DROP TABLE chat_prompt_snapshots;
		DELETE FROM ssh_agent_schema_migrations WHERE version > 16;`);
	db.exec(readFileSync(new URL(`./fixtures/chat-prompt-v16-${variant}.sql`, import.meta.url), "utf8"));
	db.exec(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
		connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
		VALUES ('w', 'test', 'development', 'localhost', 22, '/', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, revision, created_at, updated_at)
		VALUES ('s', 'w', 'test', 1, 1, 1), ('new', 'w', 'new', 1, 1, 1);
		INSERT INTO terminal_sessions (id, session_id, workspace_id, open_request_id, status,
		revision, term, rows, cols, last_event_sequence, ownership_epoch, last_consumer_activity_at, created_at, updated_at)
		VALUES ('t', 's', 'w', 'open', 'opening', 1, 'xterm-256color', 40, 160, 0, 0, 1, 1, 1);`);
	return db;
}
const snapshot = { sessionId: "s", systemPrompt: "Original immutable head\n原始环境", version: 1, createdAt: 123 };
function seedSnapshot(db: DatabaseSync, variant: "legacy" | "current") {
	if (variant === "legacy") db.prepare("INSERT INTO chat_prompt_snapshots VALUES (?, ?, ?, ?, 'command')")
		.run(snapshot.sessionId, snapshot.systemPrompt, snapshot.version, snapshot.createdAt);
	else new SqliteChatPromptRepository(db).createOnce(snapshot);
}
function messages(db: DatabaseSync) {
	return db.prepare("SELECT * FROM chat_messages ORDER BY session_id, sequence").all();
}
function transition(db: DatabaseSync) {
	db.exec("UPDATE terminal_sessions SET status='active', revision=revision+1, updated_at=updated_at+1 WHERE id='t'");
}

describe("prompt schema v17 compatibility migration", () => {
	for (const variant of ["legacy", "current"] as const) {
		it(`upgrades ${variant} v16, preserving snapshots and message identity, and is idempotent`, () => {
			const db = setup(variant);
			try {
				seedSnapshot(db, variant);
				transition(db);
				const before = messages(db);
				applyMigrations(db);
				const repository = new SqliteChatPromptRepository(db);
				expect(repository.find("s")).toEqual(snapshot);
				const after = messages(db);
				expect(after).toHaveLength(before.length);
				for (let i = 0; i < before.length; i++) {
					const oldMessage = JSON.parse(String(before[i]!.message_json));
					expect(after[i]).toEqual({ ...before[i], message_json: expect.any(String) });
					expect(JSON.parse(String(after[i]!.message_json))).toEqual({ ...oldMessage, runtimeEventId: before[i]!.id });
				}
				expect(repository.createOnce({ ...snapshot, systemPrompt: "replacement" })).toEqual(snapshot);
				expect(() => db.exec("UPDATE chat_prompt_snapshots SET system_prompt='changed'")).toThrow("immutable");
				repository.createOnce({ ...snapshot, sessionId: "new" });
				const stable = messages(db);
				const versions = db.prepare("SELECT * FROM ssh_agent_schema_migrations").all();
				applyMigrations(db);
				expect(messages(db)).toEqual(stable);
				expect(db.prepare("SELECT * FROM ssh_agent_schema_migrations").all()).toEqual(versions);
				expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
				db.exec("DELETE FROM sessions WHERE id='new'");
				expect(repository.find("new")).toBeUndefined();
				expect(repository.find("s")).toEqual(snapshot);
			} finally { db.close(); }
		});
		it(`upgrades empty ${variant} snapshots and records transitions before the first snapshot`, () => {
			const db = setup(variant);
			try {
				applyMigrations(db);
				transition(db);
				expect(messages(db)).toHaveLength(1);
				expect(new SqliteChatPromptRepository(db).createOnce(snapshot)).toEqual(snapshot);
				expect(messages(db)).toHaveLength(1);
				expect(JSON.parse(String(messages(db)[0]!.message_json))).toMatchObject({ role: "system", runtimeMode: "terminal", runtimeEventId: "terminal-mode:t:2" });
			} finally { db.close(); }
		});
	}
	it("rolls back schema, triggers and version if data repair fails, then supports retry", () => {
		const db = setup("legacy");
		try {
			seedSnapshot(db, "legacy");
			db.exec("CREATE TRIGGER fail_repair BEFORE UPDATE ON chat_messages BEGIN SELECT RAISE(ABORT, 'repair failed'); END;");
			const schema = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
			const before = messages(db);
			expect(() => applyMigrations(db)).toThrow("repair failed");
			expect(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
			expect(messages(db)).toEqual(before);
			expect(db.prepare("SELECT max(version) version FROM ssh_agent_schema_migrations").get()?.version).toBe(16);
			db.exec("DROP TRIGGER fail_repair");
			applyMigrations(db);
			expect(new SqliteChatPromptRepository(db).find("s")).toEqual(snapshot);
		} finally { db.close(); }
	});
});
