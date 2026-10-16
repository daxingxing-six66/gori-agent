import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { DeploymentService } from "../src/application/services/deployment-service.ts";
import { DefaultSshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteWorkspaceRepository } from "../src/infrastructure/sqlite/sqlite-workspace-repository.ts";
import { SqliteCredentialRepository } from "../src/infrastructure/sqlite/sqlite-credential-repository.ts";
import { SqliteDeploymentRepository } from "../src/infrastructure/sqlite/sqlite-deployment-repository.ts";
import { SqliteDeploymentDiscussionRepository } from "../src/infrastructure/sqlite/sqlite-deployment-discussion-repository.ts";
import { SqliteTransactionRunner } from "../src/infrastructure/sqlite/sqlite-transaction-runner.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gori-deploy-roots-"));
	await mkdir(join(root, ".gori"));
	await writeFile(join(root, ".gori/deploy-fixture.md"), `---
version: 1
project: fixture
target:
  host: fixture.invalid
connection:
  profile: workspace
modules:
  - id: app
    name: App
    workdir: .
    build:
      command: 'true'
      artifact: app.tar
    upload:
      target: /srv/app/app.tar
    restart:
      command: 'true'
---
`);
	const backend = createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: new Uint8Array(32).fill(1), llmModelsFactory: createTestLlmModels });
	const { workspace } = await backend.api.createWorkspace({ displayName: "test", environment: "development", host: { hostname: "fixture.invalid", port: 22 },
		credential: { displayName: "fixture", remoteUser: "fixture", secret: { type: "password", password: "synthetic" } },
		defaultCwd: root,  sandboxWritableRoots: ["/srv/app", "/var/log/app"] });
	const session = await backend.api.createSession({ workspaceId: workspace.id, displayName: "test" });
	const sessions = new SqliteSessionRepository(backend.database);
	const workspaces = new SqliteWorkspaceRepository(backend.database);
	const targets = new DefaultSshTargetResolver({ sessions, workspaces, credentials: new SqliteCredentialRepository(backend.database),
		hostTrust: { ensureTrusted: async () => ({ algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", verifiedAt: 1 }) } });
	const repository = new SqliteDeploymentRepository(backend.database);
	const discussions = new SqliteDeploymentDiscussionRepository(backend.database);
	const submit = vi.fn(async () => { throw new Error("Unexpected remote command"); });
	const service = new DeploymentService({ sessions, workspaces, targets, commands: { submit, preflightGuard: async () => ({ allowed: true }) },
		sandboxApprovals: new RemoteSandboxApprovalStore(), repository, discussions, transactions: new SqliteTransactionRunner(backend.database),
		events: new WorkspaceEventHub(), localCwd: root,
		transfers: { listDirectory: async (workspaceId, path) => ({ workspaceId, path: path ?? "/", entries: [] }),
			create: async () => { throw new Error("Unexpected transfer"); }, upload: async () => { throw new Error("Unexpected upload"); }, get: async () => { throw new Error("Unexpected transfer query"); } },
		assessRemoteSandbox: async () => ({ mode: "workspace_write", facts: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8, launcherVersion: "3", sandboxRoot: "/srv/app", sandboxRoots: ["/srv/app", "/var/log/app"] } }) });
	const change = async (roots: string[]) => backend.api.renameSession({ id: session.id, sandboxWritableRoots: roots, expectedRevision: (await backend.api.getSession(session.id)).revision });
	return { backend, service, session, repository, discussions, submit, change,
		close: async () => { await service.close(); await backend.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("deployment binding to Session writable directories", () => {
	it("rejects new deployment plans and previously prepared plans after selecting read-only mode", async () => {
		const f = await fixture();
		try {
			const plan = await f.service.prepare(f.session.id, "deploy-fixture.md", "app");
			await f.backend.api.renameSession({ id: f.session.id, expectedRevision: f.session.revision, sandboxReadOnly: true });
			await expect(f.service.prepare(f.session.id, "deploy-fixture.md", "app")).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
			await expect(f.service.beginDiscussion(f.session.id, "deploy-fixture.md", "app")).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
			await expect(f.service.claimForAgent(f.session.id, plan.id, "agent")).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
			expect(f.submit).not.toHaveBeenCalled();
		} finally { await f.close(); }
	});
	it("persists the entire scope and rejects a changed second directory before claiming or executing a stage", async () => {
		const f = await fixture();
		try {
			const plan = await f.service.prepare(f.session.id, "deploy-fixture.md", "app");
			expect(f.repository.find(f.session.id, plan.id)?.plan.targetBinding.sandboxWritableRoots).toEqual(["/srv/app", "/var/log/app"]);
			await f.change(["/srv/app", "/etc/app"]);
			await expect(f.service.claimForAgent(f.session.id, plan.id, "agent")).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
			expect(f.submit).not.toHaveBeenCalled();
		} finally { await f.close(); }
	});
	it("invalidates an idle discussion after a Session scope edit and rejects corrupt saved scope", async () => {
		const f = await fixture();
		try {
			const discussion = await f.service.beginDiscussion(f.session.id, "deploy-fixture.md", "app");
			expect(f.discussions.find(f.session.id, discussion.id)?.targetBinding.sandboxWritableRoots).toEqual(["/srv/app", "/var/log/app"]);
			await f.change(["/srv/app"]);
			await expect(f.service.bindPlanningRun(f.session.id, discussion.id, "agent")).rejects.toMatchObject({ code: "deployment_discussion_conflict" });
			f.backend.database.prepare("UPDATE deployment_discussions SET snapshot_json=json_set(snapshot_json, '$.targetBinding.sandboxWritableRoots', json('[\"/\"]')) WHERE id=?").run(discussion.id);
			expect(() => f.discussions.find(f.session.id, discussion.id)).toThrow("Saved deployment discussion is invalid");
		} finally { await f.close(); }
	});
	it("reads historical snapshots but requires review when their sandbox scope is absent", async () => {
		const f = await fixture();
		try {
			const plan = await f.service.prepare(f.session.id, "deploy-fixture.md", "app");
			delete plan.plan.targetBinding.sandboxWritableRoots;
			f.repository.update(plan);
			expect(f.repository.find(f.session.id, plan.id)?.plan.targetBinding.sandboxWritableRoots).toBeUndefined();
			await expect(f.service.claimForAgent(f.session.id, plan.id, "agent")).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
			await f.change(["/srv/app"]);
			await expect(f.service.claimForAgent(f.session.id, plan.id, "agent")).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
			expect(f.submit).not.toHaveBeenCalled();
		} finally { await f.close(); }
	});
});
