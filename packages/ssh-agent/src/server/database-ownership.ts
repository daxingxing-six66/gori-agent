import { chmodSync, closeSync, openSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";

export interface DatabaseOwnership {
	release(): void;
}

/**
 * Keep an OS-backed SQLite lock for the server lifetime. The separate file
 * avoids holding a write transaction on the application database itself.
 * SQLite releases the lock if the process exits without a clean shutdown.
 */
export function acquireDatabaseOwnership(databasePath: string): DatabaseOwnership {
	if (databasePath === ":memory:") return { release: () => undefined };
	const path = canonicalDatabasePath(databasePath);
	const lockPath = `${path}.server-lock.sqlite`;
	closeSync(openSync(lockPath, "a", 0o600));
	chmodSync(lockPath, 0o600);
	const lock = new DatabaseSync(lockPath);
	try {
		lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
	} catch (error) {
		lock.close();
		if (isBusy(error)) throw new Error("Gori database is already in use by another server", { cause: error });
		throw error;
	}
	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			try { lock.exec("ROLLBACK"); }
			finally { lock.close(); }
		},
	};
}

function canonicalDatabasePath(databasePath: string): string {
	const absolute = resolve(databasePath);
	try { return realpathSync(absolute); }
	catch (error) {
		if (!isMissing(error)) throw error;
		return join(realpathSync(dirname(absolute)), basename(absolute));
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isBusy(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" &&
		"errcode" in error && error.errcode === 5;
}
