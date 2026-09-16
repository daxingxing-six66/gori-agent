import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.ts";

export function openSshAgentDatabase(path: string): DatabaseSync {
	const database = new DatabaseSync(path);
	try {
		database.exec("PRAGMA foreign_keys = ON");
		database.exec("PRAGMA busy_timeout = 5000");
		if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
		applyMigrations(database);
		if (path !== ":memory:") restrictDatabaseFiles(path);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

function restrictDatabaseFiles(path: string): void {
	for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
		if (existsSync(candidate)) chmodSync(candidate, 0o600);
	}
}
