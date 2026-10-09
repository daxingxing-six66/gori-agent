import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDeploymentRoute } from "../src/api/deployment-routes.ts";
import { DeploymentService } from "../src/application/services/deployment-service.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteDeploymentDiscussionRepository } from "../src/infrastructure/sqlite/sqlite-deployment-discussion-repository.ts";
import { SqliteDeploymentRepository } from "../src/infrastructure/sqlite/sqlite-deployment-repository.ts";
import { SqliteTransactionRunner } from "../src/infrastructure/sqlite/sqlite-transaction-runner.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "gori-discussion-test-"));
	temporary.push(root);
	await mkdir(join(root, ".gori"));
	await writeFile(join(root, ".gori", "deploy-example.org.md"), `---
version: 2
project: test
target:
  host: example.org
connection:
  profile: current-workspace
modules:
  - id: api
    name: API
    workdir: .
    build:
      instructions: Build the jars changed by this release.
    upload:
      allowedDirectories:
        - /srv/api/lib
    restart:
      instructions: Restart the API.
---
`);
	const databasePath = join(root, "state.sqlite");
	const database = new DatabaseSync(databasePath);
	database.exec("PRAGMA foreign_keys = ON");
	applyMigrations(database);
	database.exec(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
		connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
		VALUES ('workspace-1', 'test', 'development', 'example.org', 22, '/srv/api', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, terminal_context_cursor, revision, created_at, updated_at)
		VALUES ('session-1', 'workspace-1', 'test', 0, 1, 1, 1);`);
	const transactions = new SqliteTransactionRunner(database);
	const repository = new SqliteDeploymentRepository(database);
	const discussions = new SqliteDeploymentDiscussionRepository(database);
	const target = { workspaceId: "workspace-1", workspaceRevision: 1, hostname: "example.org", port: 22,
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:test", credentialId: "credential-1",
		credentialAuthVersion: 1, remoteUser: "test", defaultCwd: "/srv/api",
		connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
	const cancelAgentRun = vi.fn(async () => undefined);
	const createService = (repository: SqliteDeploymentRepository, discussions: SqliteDeploymentDiscussionRepository,
		transactions: SqliteTransactionRunner) => new DeploymentService({
		sessions: { findById: async () => ({ id: "session-1", workspaceId: "workspace-1", workDir: root }) } as never,
		workspaces: { findById: async () => ({ id: "workspace-1", host: { hostname: "example.org" } }) } as never,
		targets: { resolve: async () => target } as never,
		commands: { preflightGuard: async () => ({ allowed: true }), submit: async () => { throw new Error("unexpected command"); } } as never,
		transfers: { listDirectory: async (_workspaceId: string, path: string) => ({ path, entries: [] }) } as never,
		sandboxApprovals: new RemoteSandboxApprovalStore(),
		repository, discussions, transactions, events: new WorkspaceEventHub(), localCwd: root, cancelAgentRun,
	});
	const service = createService(repository, discussions, transactions);
	return { root, database, databasePath, repository, discussions, service, target, cancelAgentRun, createService };
}

const proposal = {
	buildSteps: [{ workdir: ".", command: "true" }],
	artifacts: [{ source: "api.jar", target: "/srv/api/lib/api.jar" }],
	restart: { command: "systemctl restart api" },
};
const signal = () => new AbortController().signal;

describe("deployment discussions", () => {
	it("exposes the active discussion through discovery and explicit routes", async () => {
		const { service, database } = await harness();
		const base = "http://localhost/api/sessions/session-1/deployments";
		const response = await handleDeploymentRoute(service, new Request(`${base}/discussions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "deploy-example.org.md", moduleId: "api" }),
		}), ["api", "sessions", "session-1", "deployments", "discussions"]);
		expect(response?.status).toBe(201);
		const started = await response!.json() as { id: string };
		const discovery = await handleDeploymentRoute(service, new Request(base), ["api", "sessions", "session-1", "deployments"]);
		expect(await discovery!.json()).toMatchObject({ activeDiscussion: { id: started.id }, latest: null });
		const active = await handleDeploymentRoute(service, new Request(`${base}/discussions/active`),
			["api", "sessions", "session-1", "deployments", "discussions", "active"]);
		expect(await active!.json()).toMatchObject({ id: started.id });
		const cancel = await handleDeploymentRoute(service, new Request(`${base}/discussions/${started.id}/cancel`, { method: "POST" }),
			["api", "sessions", "session-1", "deployments", "discussions", started.id, "cancel"]);
		expect(await cancel!.json()).toMatchObject({ id: started.id, status: "cancelled" });
		await service.close(); database.close();
	});

	it("keeps a service selection across several Chat Runs and creates stages only when the model proposes", async () => {
		const { service, database, discussions } = await harness();
		const started = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		expect(service.activeDiscussion("session-1")?.id).toBe(started.id);
		expect(service.latest("session-1")).toBeNull();
		const first = await service.bindPlanningRun("session-1", started.id, "agent-1");
		await service.finishPlanningAgent("session-1", "agent-1", "completed");
		expect(service.activeDiscussion("session-1")?.status).toBe("discussing");
		const second = await service.bindPlanningRun("session-1", started.id, "agent-2");
		expect(second.revision).toBe(first.revision + 1);
		await expect(service.proposeForDiscussion("session-1", started.id, first.revision, "agent-1", proposal, signal()))
			.rejects.toMatchObject({ code: "deployment_discussion_conflict" });
		const run = await service.proposeForDiscussion("session-1", started.id, second.revision, "agent-2", proposal, signal());
		expect(run).toMatchObject({ status: "preparing", discussionId: started.id, planningAgentRunId: "agent-2" });
		expect(service.getDiscussion("session-1", started.id)).toMatchObject({ status: "proposed", deploymentRunId: run.id });
		expect(service.activeDiscussion("session-1")).toBeNull();
		expect(discussions.findRunBinding("session-1", "agent-2")?.revision).toBe(second.revision);
		expect((await service.proposeForDiscussion("session-1", started.id, second.revision, "agent-2", proposal, signal())).id).toBe(run.id);
		await service.close(); database.close();
	});

	it("replacing or cancelling a discussion invalidates old runs and cancels their model Run", async () => {
		const { service, database, cancelAgentRun } = await harness();
		const first = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		const bound = await service.bindPlanningRun("session-1", first.id, "agent-old");
		const second = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		expect(service.getDiscussion("session-1", first.id).status).toBe("cancelled");
		expect(cancelAgentRun).toHaveBeenCalledWith("session-1", "agent-old");
		await expect(service.proposeForDiscussion("session-1", first.id, bound.revision, "agent-old", proposal, signal()))
			.rejects.toMatchObject({ code: "deployment_discussion_conflict" });
		await service.bindPlanningRun("session-1", second.id, "agent-new");
		const cancelled = await service.cancelDiscussion("session-1", second.id);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelAgentRun).toHaveBeenCalledWith("session-1", "agent-new");
		expect((await service.cancelDiscussion("session-1", second.id)).revision).toBe(cancelled.revision);
		await service.close(); database.close();
	});

	it("rolls back the discussion transition when the plan insert fails", async () => {
		const { service, database, repository } = await harness();
		const discussion = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		const bound = await service.bindPlanningRun("session-1", discussion.id, "agent-1");
		vi.spyOn(repository, "insert").mockImplementationOnce(() => { throw new Error("insert failed"); });
		await expect(service.proposeForDiscussion("session-1", discussion.id, bound.revision, "agent-1", proposal, signal()))
			.rejects.toThrow("insert failed");
		expect(service.getDiscussion("session-1", discussion.id)).toMatchObject({ status: "discussing", revision: bound.revision });
		expect(service.latest("session-1")).toBeNull();
		await service.close(); database.close();
	});

	it("deduplicates matching concurrent proposals and rejects conflicting retries", async () => {
		const { service, database } = await harness();
		const discussion = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		const bound = await service.bindPlanningRun("session-1", discussion.id, "agent-1");
		const [first, second] = await Promise.all([
			service.proposeForDiscussion("session-1", discussion.id, bound.revision, "agent-1", proposal, signal()),
			service.proposeForDiscussion("session-1", discussion.id, bound.revision, "agent-1", proposal, signal()),
		]);
		expect(first.id).toBe(second.id);
		await expect(service.proposeForDiscussion("session-1", discussion.id, bound.revision, "agent-1",
			{ ...proposal, restart: { command: "systemctl restart other" } }, signal()))
			.rejects.toMatchObject({ code: "deployment_proposal_conflict" });
		expect(service.listHistory("session-1").runs).toHaveLength(1);
		await service.close(); database.close();
	});

	it("restores an unfinished discussion after database reopen and binds a fresh Run", async () => {
		const { service, database, databasePath, createService } = await harness();
		const discussion = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		const first = await service.bindPlanningRun("session-1", discussion.id, "agent-before-restart");
		await service.close(); database.close();
		const reopened = new DatabaseSync(databasePath);
		reopened.exec("PRAGMA foreign_keys = ON");
		applyMigrations(reopened);
		const restoredDiscussions = new SqliteDeploymentDiscussionRepository(reopened);
		const restored = createService(new SqliteDeploymentRepository(reopened), restoredDiscussions,
			new SqliteTransactionRunner(reopened));
		expect(restored.activeDiscussion("session-1")).toMatchObject({ id: discussion.id, status: "discussing" });
		const second = await restored.bindPlanningRun("session-1", discussion.id, "agent-after-restart");
		expect(second.revision).toBe(first.revision + 1);
		await restored.close(); reopened.close();
	});

	it("rejects changed target identity and corrupted SQLite snapshots", async () => {
		const { service, database, discussions, target } = await harness();
		const discussion = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		target.credentialAuthVersion += 1;
		await expect(service.bindPlanningRun("session-1", discussion.id, "agent-1"))
			.rejects.toMatchObject({ code: "deployment_discussion_conflict" });
		database.prepare(`UPDATE deployment_discussions
			SET snapshot_json = json_set(snapshot_json, '$.targetBinding.port', 'invalid') WHERE id = ?`).run(discussion.id);
		expect(() => discussions.findActive("session-1")).toThrowError(/Saved deployment discussion is invalid/u);
		await service.close(); database.close();
	});

	it("requires the selected profile to remain unchanged before a later model Run", async () => {
		const { service, database, root } = await harness();
		const discussion = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		await appendFile(join(root, ".gori", "deploy-example.org.md"), "\nChanged deployment notes.\n");
		await expect(service.bindPlanningRun("session-1", discussion.id, "agent-later"))
			.rejects.toMatchObject({ code: "deployment_discussion_conflict" });
		expect(service.activeDiscussion("session-1")?.revision).toBe(discussion.revision);
		await service.close(); database.close();
	});

	it("persists cancellation even if stopping the old model Run fails", async () => {
		const { service, database, cancelAgentRun } = await harness();
		const discussion = await service.beginDiscussion("session-1", "deploy-example.org.md", "api");
		await service.bindPlanningRun("session-1", discussion.id, "agent-old");
		cancelAgentRun.mockRejectedValueOnce(new Error("run cancellation failed"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const result = await service.cancelDiscussion("session-1", discussion.id);
			expect(result.status).toBe("cancelled");
			expect(service.activeDiscussion("session-1")).toBeNull();
			expect(warning).toHaveBeenCalledTimes(1);
		} finally { warning.mockRestore(); }
		await service.close(); database.close();
	});
});
