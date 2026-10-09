import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DeploymentRun } from "../src/domain/deployment.ts";
import { SqliteDeploymentRepository } from "../src/infrastructure/sqlite/sqlite-deployment-repository.ts";
import {
	SqliteTransactionBusyError,
	SqliteTransactionRunner,
} from "../src/infrastructure/sqlite/sqlite-transaction-runner.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("SqliteTransactionRunner", () => {
	it("commits a synchronous operation before queued unrelated reads", async () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec("CREATE TABLE events (id INTEGER PRIMARY KEY)");
			const transactions = new SqliteTransactionRunner(database);
			let observed: unknown;
			let finishObservation: () => void = () => undefined;
			const observation = new Promise<void>((resolve) => {
				finishObservation = resolve;
			});
			await transactions.run(() => {
				database.prepare("INSERT INTO events (id) VALUES (1)").run();
				queueMicrotask(() => {
					try {
						observed = database.prepare("SELECT id FROM events").all();
					} catch (error) {
						observed = error;
					} finally {
						finishObservation();
					}
				});
			});
			await observation;
			expect(observed).toEqual([{ id: 1 }]);
		} finally {
			database.close();
		}
	});

	it("rejects an unrelated write rather than rolling it back with a suspended transaction", async () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec("CREATE TABLE events (id INTEGER PRIMARY KEY)");
			const transactions = new SqliteTransactionRunner(database);
			const precompiledInsert = database.prepare("INSERT INTO events (id) VALUES (?)");
			const entered = deferred();
			const release = deferred();
			const transaction = transactions.run(async () => {
				database.prepare("INSERT INTO events (id) VALUES (1)").run();
				entered.resolve();
				await release.promise;
				throw new Error("rollback owner transaction");
			});
			await entered.promise;

			expect(() => precompiledInsert.run(2)).toThrow(SqliteTransactionBusyError);
			expect(() => database.exec("INSERT INTO events (id) VALUES (3)")).toThrow(SqliteTransactionBusyError);
			expect(() => database.prepare("SELECT COUNT(*) FROM events").get()).toThrow(SqliteTransactionBusyError);
			release.resolve();
			await expect(transaction).rejects.toThrow("rollback owner transaction");

			precompiledInsert.run(2);
			expect(database.prepare("SELECT id FROM events").all()).toEqual([{ id: 2 }]);
		} finally {
			database.close();
		}
	});

	it("queues another owned transaction until the first one commits", async () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec("CREATE TABLE events (id INTEGER PRIMARY KEY)");
			const transactions = new SqliteTransactionRunner(database);
			const entered = deferred();
			const release = deferred();
			const first = transactions.run(async () => {
				database.prepare("INSERT INTO events (id) VALUES (1)").run();
				entered.resolve();
				await release.promise;
				database.prepare("INSERT INTO events (id) VALUES (2)").run();
			});
			await entered.promise;
			const second = transactions.run(async () => {
				database.prepare("INSERT INTO events (id) VALUES (3)").run();
			});
			release.resolve();
			await Promise.all([first, second]);
			expect(database.prepare("SELECT id FROM events ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		} finally {
			database.close();
		}
	});

	it("does not publish a deployment repository row into an unrelated rollback", async () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY);
				CREATE TABLE deployment_runs (id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT,
					status TEXT, snapshot_json TEXT, created_at INTEGER, updated_at INTEGER);`);
			const transactions = new SqliteTransactionRunner(database);
			const deployments = new SqliteDeploymentRepository(database);
			const run: DeploymentRun = {
				id: "deploy-1", sessionId: "session-1", workspaceId: "workspace-1", status: "preparing",
				createdAt: 1, updatedAt: 1,
				plan: {
					profilePath: "/tmp/deploy.md", profileHash: "hash", project: "test",
					remoteAccess: { mode: "workspace_write" }, target: { host: "example.org" },
					targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "credential-1",
						credentialAuthVersion: 1, remoteUser: "test", writableRoot: "/srv/app" },
					module: { id: "api", name: "API" },
					build: { cwd: "/tmp", command: "true", artifact: "/tmp/api.jar" },
					upload: { remotePath: "/srv/app/api.jar" }, restart: { command: "true" },
				},
				stages: {
					prepare: { status: "success", log: "", startedAt: 1, finishedAt: 1 },
					build: { status: "pending", log: "" }, upload: { status: "pending", log: "" },
					restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" },
				},
			};
			const entered = deferred();
			const release = deferred();
			const transaction = transactions.run(async () => {
				database.prepare("INSERT INTO events (id) VALUES (1)").run();
				entered.resolve();
				await release.promise;
				throw new Error("rollback");
			});
			await entered.promise;
			expect(() => deployments.insert(run)).toThrow(SqliteTransactionBusyError);
			release.resolve();
			await expect(transaction).rejects.toThrow("rollback");
			expect(deployments.find("session-1", run.id)).toBeUndefined();
			deployments.insert(run);
			expect(deployments.find("session-1", run.id)).toEqual(run);
		} finally {
			database.close();
		}
	});
});
