import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DeploymentRun } from "../src/domain/deployment.ts";
import { SqliteDeploymentRepository } from "../src/infrastructure/sqlite/sqlite-deployment-repository.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";

function fixture(): { database: DatabaseSync; repository: SqliteDeploymentRepository; run: DeploymentRun } {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	applyMigrations(database);
	database.exec(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
		connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
		VALUES ('workspace-1', 'test', 'development', 'example.org', 22, '/srv/app', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, terminal_context_cursor, revision, created_at, updated_at)
		VALUES ('session-1', 'workspace-1', 'test', 0, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, terminal_context_cursor, revision, created_at, updated_at)
		VALUES ('session-2', 'workspace-1', 'second', 0, 1, 1, 1);`);
	const repository = new SqliteDeploymentRepository(database);
	const run: DeploymentRun = {
		id: "deploy-1", sessionId: "session-1", workspaceId: "workspace-1", status: "preparing",
		planningAgentRunId: "planning-1", planningProposalHash: "a".repeat(64), createdAt: 2, updatedAt: 2,
		plan: {
			version: 2,
			profilePath: "/tmp/project/.gori/deploy-example.org.md", profileHash: "hash", project: "test",
			remoteAccess: { mode: "workspace_write" }, target: { host: "example.org" },
			targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "credential-1", credentialAuthVersion: 1, remoteUser: "test", writableRoot: "/srv/app" },
			module: { id: "api", name: "API" },
			buildSteps: [{ cwd: "/tmp/project", command: "mvn package -pl api" }],
			artifacts: [
				{ source: "/tmp/project/common.jar", remotePath: "/srv/app/lib/common.jar" },
				{ source: "/tmp/project/api.jar", remotePath: "/srv/app/api.jar" },
			],
			restart: { command: "systemctl restart api" },
		},
		stages: {
			prepare: { status: "success", log: "", startedAt: 2, finishedAt: 2 },
			build: { status: "pending", log: "" }, upload: { status: "pending", log: "" },
			restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" },
		},
	};
	return { database, repository, run };
}

describe("deployment v2 snapshot boundary", () => {
	it("round-trips a multi-artifact plan and enforces a unique planning Run per Session", () => {
		const { database, repository, run } = fixture();
		try {
			repository.insert(run);
			expect(repository.findByPlanningAgentRunId("session-1", "planning-1")).toEqual(run);
			expect(repository.findByPlanningAgentRunId("session-2", "planning-1")).toBeUndefined();
			expect(() => repository.insert({ ...run, id: "deploy-2" })).toThrow();
			repository.insert({ ...run, id: "deploy-3", sessionId: "session-2" });
			expect(repository.findByPlanningAgentRunId("session-2", "planning-1")?.id).toBe("deploy-3");
			expect(database.prepare("SELECT version FROM ssh_agent_schema_migrations WHERE version = 24").get()).toEqual({ version: 24 });
		} finally { database.close(); }
	});

	it("validates per-stage sandbox access, declared writes and exception approval markers", () => {
		const { database, repository, run } = fixture();
		try {
			if (run.plan.version !== 2) throw new Error("Expected v2 fixture");
			run.plan.remoteAccess = { mode: "full_access", reason: "sandbox_scope_exceeded" };
			run.plan.restart = { command: "install config /etc/app/config", writePaths: ["/etc/app/config"],
				access: { mode: "full_access", reason: "sandbox_scope_exceeded" } };
			run.fullAccessApprovals = { restart: { id: "approval-1", stage: "restart", command: run.plan.restart.command,
				status: "pending", requestedAt: 2, toolName: "remote_sandbox_exception", reason: "sandbox_scope_exceeded" } };
			repository.insert(run);
			expect(repository.find("session-1", run.id)).toEqual(run);
			const corrupt = (path: string, value: unknown) => {
				database.prepare("UPDATE deployment_runs SET snapshot_json = json_set(snapshot_json, ?, json(?)) WHERE id = ?")
					.run(path, JSON.stringify(value), run.id);
				expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
				repository.update(run);
			};
			corrupt("$.plan.restart.writePaths[0]", "/etc/../srv/app");
			corrupt("$.plan.restart.access.mode", "workspace_write");
			corrupt("$.fullAccessApprovals.restart.toolName", "ordinary_command");
			corrupt("$.fullAccessApprovals.restart.reason", "sandbox_unavailable");
			database.prepare("UPDATE deployment_runs SET snapshot_json = json_remove(snapshot_json, '$.fullAccessApprovals.restart.toolName') WHERE id = ?")
				.run(run.id);
			expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
		} finally { database.close(); }
	});

	it("rejects damaged generated paths, counts, bindings and v1/v2 field mixtures", () => {
		const { database, repository, run } = fixture();
		try {
			repository.insert(run);
			const corrupt = (path: string, value: unknown) => {
				database.prepare("UPDATE deployment_runs SET snapshot_json = json_set(snapshot_json, ?, json(?)) WHERE id = ?")
					.run(path, JSON.stringify(value), run.id);
				expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
				repository.update(run);
			};
			corrupt("$.plan.buildSteps", []);
			corrupt("$.plan.artifacts[0].source", "../outside.jar");
			corrupt("$.plan.artifacts[0].remotePath", "/srv/app/../outside.jar");
			corrupt("$.plan.artifacts[1].remotePath", "/srv/app/lib/common.jar");
			corrupt("$.plan.build", { cwd: "/tmp/project", command: "echo bypass", artifact: "/tmp/project/file" });
			corrupt("$.planningProposalHash", "short");
			corrupt("$.planningAgentRunId", 42);
			const legacyPlan = { ...run.plan, version: undefined, buildSteps: undefined, artifacts: undefined,
				build: { cwd: "/tmp/project", command: "mvn package", artifact: "/tmp/project/api.jar" },
				upload: { remotePath: "/srv/app/api.jar" } };
			const legacy = { ...run, planningAgentRunId: undefined, planningProposalHash: undefined, plan: legacyPlan };
			repository.update(legacy as DeploymentRun);
			expect(repository.find("session-1", run.id)?.plan.version).toBeUndefined();
			corrupt("$.planningAgentRunId", "planning-1");
		} finally { database.close(); }
	});

	it("loads a recoverable failed stage and rejects damaged attempt or proposal history", () => {
		const { database, repository, run } = fixture();
		try {
			if (run.plan.version !== 2) throw new Error("Expected a model-generated fixture");
			const repairedPlan = { ...run.plan, buildSteps: [{ cwd: "/tmp/project", command: "mvn package -pl api -am" }] };
			const recovering: DeploymentRun = {
				...run, status: "recovering", startedAt: 3, updatedAt: 5, agentRunId: "agent-1",
				agentRunHistory: ["agent-1"], planRevision: 1, initialPlan: run.plan,
				stages: { ...run.stages, build: { status: "failed", log: "compile error", error: "Build exited", startedAt: 3, finishedAt: 4 } },
				stageAttempts: { build: [{ agentRunId: "agent-1", planRevision: 1,
					result: { status: "failed", log: "compile error", error: "Build exited", startedAt: 3, finishedAt: 4 } }] },
				recoveries: [{ id: "repair-1", stage: "build", reason: "Use the correct build graph", plan: repairedPlan,
					baseRevision: 1, status: "pending", agentRunId: "agent-1", proposedAt: 5 }],
			};
			repository.insert(recovering);
			expect(repository.find("session-1", run.id)).toEqual(recovering);
			const corrupt = (path: string, value: unknown) => {
				database.prepare("UPDATE deployment_runs SET snapshot_json = json_set(snapshot_json, ?, json(?)) WHERE id = ?")
					.run(path, JSON.stringify(value), run.id);
				expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
				repository.update(recovering);
			};
			corrupt("$.recoveries[0].baseRevision", 2);
			corrupt("$.recoveries[0].plan.target.host", "different-host");
			corrupt("$.recoveries[0].plan.restart.command", "systemctl restart unreviewed");
			corrupt("$.stageAttempts.build[0].result.status", "running");
			corrupt("$.stageAttempts.build[0].result.progress", null);
			corrupt("$.agentRunHistory", ["agent-1", "agent-1"]);
		} finally { database.close(); }
	});

	it("migrates an existing deployment row to the recoverable status constraint", () => {
		const { database, repository, run } = fixture();
		try {
			repository.insert(run);
			database.exec(`DROP TABLE deployment_runs;
				CREATE TABLE deployment_runs (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
					workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
					status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'success', 'failed', 'cancelled')),
					snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
					created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
				) STRICT;
				DELETE FROM ssh_agent_schema_migrations WHERE version = 26;`);
			repository.insert(run);
			applyMigrations(database);
			expect(repository.find("session-1", run.id)).toEqual(run);
			expect(database.prepare("SELECT version FROM ssh_agent_schema_migrations WHERE version = 26").get()).toEqual({ version: 26 });
			database.prepare("UPDATE deployment_runs SET status = 'recovering' WHERE id = ?").run(run.id);
			expect(database.prepare("SELECT status FROM deployment_runs WHERE id = ?").get(run.id)).toEqual({ status: "recovering" });
		} finally { database.close(); }
	});

	it("requires fresh Full Access decisions for unfinished recovery commands after restart", () => {
		const { database, repository, run } = fixture();
		try {
			const recovering: DeploymentRun = { ...run, status: "recovering", startedAt: 3, updatedAt: 5,
				agentRunId: "agent-1", agentRunHistory: ["agent-1"],
				plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } },
				stages: { ...run.stages, build: { status: "failed", log: "compile error", error: "Build exited" } },
				fullAccessApprovals: { restart: { id: "approval-old", stage: "restart", command: run.plan.restart.command,
					status: "approved", requestedAt: 3, resolvedAt: 4, expiresAt: 10_000 } },
			};
			repository.insert(recovering);
			repository.recoverInterrupted(6);
			const restored = repository.find("session-1", run.id);
			expect(restored?.status).toBe("recovering");
			expect(restored?.fullAccessApprovals?.restart).toMatchObject({ status: "pending", command: run.plan.restart.command, requestedAt: 6 });
			expect(restored?.fullAccessApprovals?.restart?.id).not.toBe("approval-old");
		} finally { database.close(); }
	});
});
