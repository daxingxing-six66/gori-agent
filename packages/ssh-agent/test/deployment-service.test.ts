import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentService } from "../src/application/services/deployment-service.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import type { SubmitCommandInput } from "../src/application/services/command-operation-service.ts";
import type { DeploymentRun } from "../src/domain/deployment.ts";
import type { RemoteSandboxRoute } from "../src/application/services/remote-sandbox-routing.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteDeploymentRepository } from "../src/infrastructure/sqlite/sqlite-deployment-repository.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function harness(overrides: { sandboxEnabledRef?: { current: boolean }; host?: string; remoteRoot?: string; guard?: boolean; remoteFails?: boolean; remoteFailureRef?: { current: boolean }; remoteFailureCode?: "remote_exit_non_zero" | "sandbox_partial_enforcement"; transferHost?: string; buildCommand?: string; uploadGate?: Promise<void>; includeVerify?: boolean; cancelAgentRun?: (sessionId: string, agentRunId: string) => Promise<void>; assessRemoteSandbox?: (paths: readonly string[]) => RemoteSandboxRoute } = {}) {
	const root = await mkdtemp(join(tmpdir(), "gori-deploy-test-"));
	temporary.push(root);
	await mkdir(join(root, ".gori"));
	await writeFile(join(root, ".gori", "deploy-example.org.md"), `---
version: 1
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
      command: ${overrides.buildCommand ?? "node -e \"require('node:fs').writeFileSync('artifact.tar.gz','data')\""}
      artifact: ./artifact.tar.gz
    upload:
      target: /srv/api/artifact.tar.gz
    restart:
      command: systemctl restart api
${overrides.includeVerify === false ? "" : "    verify:\n      command: systemctl is-active api\n"}---
`);
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	applyMigrations(database);
	database.exec(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
		connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
		VALUES ('workspace-1', 'test', 'development', 'example.org', 22, '/srv/api', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, terminal_context_cursor, revision, created_at, updated_at)
		VALUES ('session-1', 'workspace-1', 'test', 0, 1, 1, 1);`);
	const repository = new SqliteDeploymentRepository(database);
	const lifecycle = new SessionLifecycleCoordinator();
	const sandboxApprovals = new RemoteSandboxApprovalStore();
	const upload = vi.fn(async (_workspaceId: string, _id: string, data: AsyncIterable<Uint8Array>) => {
		let content = "";
		for await (const chunk of data) content += Buffer.from(chunk).toString();
		expect(content).toBe("data");
		await overrides.uploadGate;
		return { status: "completed", bytesTransferred: 4, totalBytes: 4 };
	});
	const submit = vi.fn(async (input: SubmitCommandInput) => {
		if (input.sandboxPermissions === "full_access" && !sandboxApprovals.consume({
			agentRunId: input.fullAccessApprovalScopeId ?? "", toolCallId: input.toolCallId,
			sessionId: input.sessionId, command: input.command, cwd: input.cwd,
			timeoutMs: input.timeoutMs, justification: input.justification ?? "",
		})) return { operation: { status: "failed", failure: { message: "Full Access grant missing" } } };
		return { operation: (overrides.remoteFailureRef?.current ?? overrides.remoteFails)
			? { id: `operation-${input.toolCallId}`, status: "failed", exitCode: 1, failure: {
				code: overrides.remoteFailureCode ?? "remote_exit_non_zero", category: "execution", phase: "execute", message: "restart failed", retryable: false,
				safeDetails: { exitCode: 1, commandMayHaveRun: true },
			} }
			: { id: `operation-${input.toolCallId}`, status: "completed" } };
	});
	const target = { workspaceId: "workspace-1", workspaceRevision: 1, hostname: overrides.host ?? "example.org", port: 22,
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:test", credentialId: "credential-1",
		credentialAuthVersion: 1, remoteUser: "test", defaultCwd: overrides.remoteRoot ?? "/srv/api",
		connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
	const service = new DeploymentService({
		sessions: { findById: async () => ({ id: "session-1", workspaceId: "workspace-1", workDir: root, sandboxEnabled: overrides.sandboxEnabledRef?.current ?? true }) } as never,
		workspaces: { findById: async () => ({ id: "workspace-1", host: { hostname: overrides.host ?? "example.org" } }) } as never,
		targets: { resolve: async () => target } as never,
		commands: { submit, preflightGuard: async () => ({ allowed: overrides.guard !== false }) } as never,
		sandboxApprovals,
		transfers: {
			listDirectory: async (_workspaceId: string, path: string) => ({ path, entries: [] }),
			create: async () => ({ id: "transfer-1", target: { ...target, hostname: overrides.transferHost ?? target.hostname } }), upload,
			get: async () => ({ bytesTransferred: 0, totalBytes: 4 }),
		} as never,
		repository, events: new WorkspaceEventHub(), localCwd: root, lifecycle,
		cancelAgentRun: overrides.cancelAgentRun,
		...(overrides.assessRemoteSandbox ? { assessRemoteSandbox: async (_target, paths) => overrides.assessRemoteSandbox!(paths) } : {}),
	});
	return { root, database, repository, service, upload, submit, lifecycle, sandboxApprovals, target };
}

const AGENT_RUN_ID = "agent-run-1";
const agentSignal = () => new AbortController().signal;
const sandboxReady: RemoteSandboxRoute = { mode: "workspace_write", facts: {
	mode: "workspace_write", backend: "bubblewrap", enforcement: "full", sandboxRoot: "/srv/api", bubblewrapVersion: "0.13.0",
} };

async function writeV2Profile(root: string): Promise<void> {
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
      instructions: Build the artifact.
    upload:
      allowedDirectories:
        - /srv/api
    restart:
      instructions: Restart the API.
    verify:
      instructions: Verify the API.
---
`);
}

async function runStages(service: DeploymentService, id: string) {
	for (const stage of ["build", "upload", "restart", "verify"] as const) {
		const run = await service.executeStageForAgent("session-1", id, AGENT_RUN_ID, stage, agentSignal());
		if (run.status !== "running") return run;
	}
	return service.get("session-1", id);
}

async function claimAndRun(service: DeploymentService, id: string) {
	approveDeployment(service, id);
	await service.claimForAgent("session-1", id, AGENT_RUN_ID);
	return runStages(service, id);
}

function approveDeployment(service: DeploymentService, id: string, sessionId = "session-1") {
	const run = service.get(sessionId, id);
	for (const stage of ["restart", "verify"] as const) {
		const approval = run.fullAccessApprovals?.[stage];
		if (approval) service.decideFullAccess(sessionId, id, stage, approval.id, true);
	}
}

describe("deployment workflow", () => {
	it("skips all sandbox assessments and exception grants for a disabled Session", async () => {
		const assessRemoteSandbox = vi.fn(() => sandboxReady);
		const { service, database, submit } = await harness({ sandboxEnabledRef: { current: false }, assessRemoteSandbox });
		try {
			const plan = await service.prepare("session-1", "deploy-example.org.md", "api");
			expect(plan.plan.remoteAccess).toEqual({ mode: "full_access", reason: "session_sandbox_disabled" });
			expect(plan.fullAccessApprovals).toBeUndefined();
			expect(service.previewRemoteStage("session-1", plan.id, "restart")).toMatchObject({ sessionAuthorized: true });
			await service.claimForAgent("session-1", plan.id, AGENT_RUN_ID);
			expect((await runStages(service, plan.id)).status).toBe("success");
			expect(assessRemoteSandbox).not.toHaveBeenCalled();
			for (const [input] of submit.mock.calls) {
				expect(input.expectedSandboxEnabled).toBe(false);
				expect(input).not.toHaveProperty("fullAccessApprovalScopeId");
			}
		} finally { await service.close(); database.close(); }
	});

	it.each([true, false])("refuses stale plans when sandbox was %s during planning", async (enabled) => {
		const sandboxEnabledRef = { current: enabled };
		const { service, database, submit, upload } = await harness({ sandboxEnabledRef, assessRemoteSandbox: () => sandboxReady });
		try {
			const plan = await service.prepare("session-1", "deploy-example.org.md", "api");
			sandboxEnabledRef.current = !enabled;
			await expect(service.claimForAgent("session-1", plan.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
			expect(submit).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
		} finally { await service.close(); database.close(); }
	});
	it("runs both remote stages inside an available sandbox without Full Access approval", async () => {
		const checkedPaths: string[][] = [];
		const { service, database, submit } = await harness({ assessRemoteSandbox: (paths) => {
			checkedPaths.push([...paths]);
			return sandboxReady;
		} });
		const plan = await service.prepare("session-1", "deploy-example.org.md", "api");
		expect(plan.plan.remoteAccess).toEqual({ mode: "workspace_write" });
		expect(plan.fullAccessApprovals).toBeUndefined();
		expect(service.previewRemoteStage("session-1", plan.id, "restart")).toEqual({ command: "systemctl restart api", mode: "workspace_write" });
		expect(checkedPaths).toEqual([[], []]);
		await service.claimForAgent("session-1", plan.id, AGENT_RUN_ID);
		expect((await runStages(service, plan.id)).status).toBe("success");
		expect(submit.mock.calls.map(([input]) => input.sandboxPermissions)).toEqual(["workspace_write", "workspace_write"]);
		await service.close(); database.close();
	});

	it("marks an unavailable sandbox as a human-only exception even when commands were otherwise valid", async () => {
		const { service, database, submit } = await harness({ assessRemoteSandbox: () => ({
			mode: "full_access", reason: "sandbox_unavailable", details: "No supported backend",
		}) });
		const plan = await service.prepare("session-1", "deploy-example.org.md", "api");
		expect(plan.fullAccessApprovals?.restart).toMatchObject({ toolName: "remote_sandbox_exception", reason: "sandbox_unavailable" });
		expect(plan.fullAccessApprovals?.verify).toMatchObject({ toolName: "remote_sandbox_exception", reason: "sandbox_unavailable" });
		await expect(service.claimForAgent("session-1", plan.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		expect(submit).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it("invalidates an unavailable-sandbox exception if a sandbox becomes usable before claim", async () => {
		let available = false;
		const { service, database, root, submit, upload } = await harness({ assessRemoteSandbox: () => available
			? sandboxReady : { mode: "full_access", reason: "sandbox_unavailable", details: "No supported backend" } });
		const plan = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, plan.id);
		available = true;
		await expect(service.claimForAgent("session-1", plan.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_sandbox_route_changed" });
		expect(service.get("session-1", plan.id).status).toBe("preparing");
		await expect(stat(join(root, "artifact.tar.gz"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(upload).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it("stops a claimed Full Access stage if its sandbox exception becomes stale before dispatch", async () => {
		let available = false;
		const { service, database, submit } = await harness({ assessRemoteSandbox: () => available
			? sandboxReady : { mode: "full_access", reason: "sandbox_unavailable", details: "No supported backend" } });
		const plan = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, plan.id);
		await service.claimForAgent("session-1", plan.id, AGENT_RUN_ID);
		for (const stage of ["build", "upload"] as const)
			await service.executeStageForAgent("session-1", plan.id, AGENT_RUN_ID, stage, agentSignal());
		available = true;
		const stopped = await service.executeStageForAgent("session-1", plan.id, AGENT_RUN_ID, "restart", agentSignal());
		expect(stopped).toMatchObject({ status: "failed", stages: { restart: {
			status: "failed", error: expect.stringContaining("review a new deployment plan"),
		} } });
		expect(submit).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it("limits a declared out-of-root sandbox exception to the affected deployment stage", async () => {
		const assessed: string[][] = [];
		const { service, database, root, submit } = await harness({ assessRemoteSandbox: (paths) => {
			assessed.push([...paths]);
			return paths.some((path) => path.startsWith("/etc/"))
				? { mode: "full_access", reason: "write_path_outside_sandbox", details: "Declared write path is outside the sandbox" }
				: sandboxReady;
		} });
		await writeV2Profile(root);
		const plan = await service.proposeForAgent("session-1", "planner-scope", "deploy-example.org.md", "api", {
			buildSteps: [{ workdir: ".", command: "node -e \"require('node:fs').writeFileSync('artifact.tar.gz','data')\"" }],
			artifacts: [{ source: "artifact.tar.gz", target: "/srv/api/artifact.tar.gz" }],
			restart: { command: "install /srv/api/service.conf /etc/api/service.conf", writePaths: ["/etc/api/service.conf"] },
			verify: { command: "test -f /srv/api/artifact.tar.gz", writePaths: ["/srv/api/artifact.tar.gz"] },
		}, agentSignal());
		expect(assessed).toEqual([["/etc/api/service.conf"], ["/srv/api/artifact.tar.gz"]]);
		expect(plan.plan.restart.access).toEqual({ mode: "full_access", reason: "sandbox_scope_exceeded" });
		expect(plan.plan.verify?.access).toEqual({ mode: "workspace_write" });
		expect(plan.fullAccessApprovals?.restart).toMatchObject({ toolName: "remote_sandbox_exception", reason: "sandbox_scope_exceeded" });
		expect(plan.fullAccessApprovals?.verify).toBeUndefined();
		await expect(service.claimForAgent("session-1", plan.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		approveDeployment(service, plan.id);
		await service.claimForAgent("session-1", plan.id, AGENT_RUN_ID);
		expect((await runStages(service, plan.id)).status).toBe("success");
		expect(submit.mock.calls.map(([input]) => input.sandboxPermissions)).toEqual(["full_access", "workspace_write"]);
		await service.close(); database.close();
	});

	it("stops after a sandboxed script failure and requires a new approved exception plan for retry", async () => {
		const remoteFailureRef = { current: true };
		const { service, database, root, submit } = await harness({ remoteFailureRef, remoteFailureCode: "sandbox_partial_enforcement",
			assessRemoteSandbox: (paths) => paths.includes("/etc/api/service.conf")
				? { mode: "full_access", reason: "write_path_outside_sandbox", details: "The declared write is outside the sandbox" }
				: sandboxReady });
		await writeV2Profile(root);
		const plan = await service.proposeForAgent("session-1", "planner-retry", "deploy-example.org.md", "api", {
			buildSteps: [{ workdir: ".", command: "node -e \"require('node:fs').writeFileSync('artifact.tar.gz','data')\"" }],
			artifacts: [{ source: "artifact.tar.gz", target: "/srv/api/artifact.tar.gz" }],
			restart: { command: "./startup.sh restart" }, verify: { command: "true" },
		}, agentSignal());
		expect(plan.plan.restart.access).toEqual({ mode: "workspace_write" });
		await service.claimForAgent("session-1", plan.id, AGENT_RUN_ID);
		for (const stage of ["build", "upload", "restart"] as const)
			await service.executeStageForAgent("session-1", plan.id, AGENT_RUN_ID, stage, agentSignal());
		const failed = service.get("session-1", plan.id);
		expect(failed).toMatchObject({ status: "recovering", stages: { restart: { failureCode: "sandbox_partial_enforcement" } } });
		expect(submit).toHaveBeenCalledTimes(1);
		expect(submit.mock.calls[0]?.[0].sandboxPermissions).toBe("workspace_write");
		const repair = await service.proposeRecoveryForAgent("session-1", plan.id, AGENT_RUN_ID, 1, {
			stage: "restart", reason: "The script needs to write service configuration", command: "./startup.sh restart",
			writePaths: ["/etc/api/service.conf"],
		}, agentSignal());
		expect(repair.recoveries?.at(-1)?.plan.restart.access).toEqual({ mode: "full_access", reason: "sandbox_scope_exceeded" });
		await service.decideRecovery("session-1", plan.id, repair.recoveries!.at(-1)!.id, true);
		await expect(service.claimForAgent("session-1", plan.id, "agent-run-2")).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		approveDeployment(service, plan.id);
		remoteFailureRef.current = false;
		await service.claimForAgent("session-1", plan.id, "agent-run-2");
		for (const stage of ["restart", "verify"] as const)
			await service.executeStageForAgent("session-1", plan.id, "agent-run-2", stage, agentSignal());
		expect(submit.mock.calls.map(([input]) => input.sandboxPermissions)).toEqual(["workspace_write", "full_access", "workspace_write"]);
		await service.close(); database.close();
	});
	it("keeps a failed model-planned build recoverable and resumes the same deployment after review", async () => {
		const { service, database, root, upload } = await harness();
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
      instructions: Build the release artifact.
    upload:
      allowedDirectories:
        - /srv/api
    restart:
      instructions: Restart the API.
    verify:
      instructions: Verify the API.
---
`);
		const plan = await service.proposeForAgent("session-1", "planning-agent", "deploy-example.org.md", "api", {
			buildSteps: [{ workdir: ".", command: "node -e \"process.exit(1)\"" }],
			artifacts: [{ source: "artifact.tar.gz", target: "/srv/api/artifact.tar.gz" }],
			restart: { command: "systemctl restart api" }, verify: { command: "systemctl is-active api" },
		}, agentSignal());
		approveDeployment(service, plan.id);
		await service.claimForAgent("session-1", plan.id, AGENT_RUN_ID);
		const failed = await service.executeStageForAgent("session-1", plan.id, AGENT_RUN_ID, "build", agentSignal());
		expect(failed).toMatchObject({ status: "recovering", stages: { build: { status: "failed" } } });
		expect(failed.stageAttempts?.build).toHaveLength(1);
		expect(upload).not.toHaveBeenCalled();
		await service.finishAgent("session-1", plan.id, AGENT_RUN_ID, "completed");
		const proposed = await service.proposeRecoveryForAgent("session-1", plan.id, AGENT_RUN_ID, 1, {
			stage: "build", reason: "The previous build command exited before creating the artifact",
			buildSteps: [{ workdir: ".", command: "node -e \"require('node:fs').writeFileSync('artifact.tar.gz','data')\"" }],
		}, agentSignal());
		expect(proposed.recoveries?.at(-1)).toMatchObject({ stage: "build", status: "pending", baseRevision: 1 });
		expect(proposed.plan).toEqual(plan.plan);
		await expect(service.bindRecoveryAgent("session-1", plan.id, "agent-run-2"))
			.rejects.toMatchObject({ code: "deployment_recovery_unavailable" });
		const sameProposal = await service.proposeRecoveryForAgent("session-1", plan.id, AGENT_RUN_ID, 1, {
			stage: "build", reason: "The previous build command exited before creating the artifact",
			buildSteps: [{ workdir: ".", command: "node -e \"require('node:fs').writeFileSync('artifact.tar.gz','data')\"" }],
		}, agentSignal());
		expect(sameProposal.recoveries).toHaveLength(1);
		await expect(service.proposeRecoveryForAgent("session-1", plan.id, AGENT_RUN_ID, 1, {
			stage: "build", reason: "Different repair", buildSteps: [{ workdir: ".", command: "make" }],
		}, agentSignal())).rejects.toMatchObject({ code: "deployment_recovery_conflict" });
		await expect(service.claimForAgent("session-1", plan.id, "agent-run-2")).rejects.toMatchObject({ code: "deployment_agent_mismatch" });
		const reviewed = await service.decideRecovery("session-1", plan.id, proposed.recoveries!.at(-1)!.id, true);
		expect(await service.decideRecovery("session-1", plan.id, proposed.recoveries!.at(-1)!.id, true)).toEqual(reviewed);
		await expect(service.decideRecovery("session-1", plan.id, proposed.recoveries!.at(-1)!.id, false))
			.rejects.toMatchObject({ code: "deployment_recovery_conflict" });
		expect(reviewed).toMatchObject({ status: "recovering", planRevision: 2, stages: { build: { status: "pending" } } });
		expect(reviewed.stageAttempts?.build?.[0]?.result.status).toBe("failed");
		await expect(service.claimForAgent("session-1", plan.id, "agent-run-2")).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		approveDeployment(service, plan.id);
		await service.claimForAgent("session-1", plan.id, "agent-run-2");
		for (const stage of ["build", "upload", "restart", "verify"] as const)
			await service.executeStageForAgent("session-1", plan.id, "agent-run-2", stage, agentSignal());
		const finished = service.get("session-1", plan.id);
		expect(finished.status).toBe("success");
		expect(finished.stageAttempts?.build).toHaveLength(2);
		expect(finished.agentRunHistory).toEqual([AGENT_RUN_ID, "agent-run-2"]);
		expect(finished.initialPlan?.buildSteps[0]?.command).toContain("process.exit(1)");
		expect(upload).toHaveBeenCalledOnce();
		await service.close(); database.close();
	});

	it("retries only a failed remote stage with a new one-use approval and command identity", async () => {
		const remoteFailureRef = { current: true };
		const { service, database, root, upload, submit } = await harness({ remoteFailureRef });
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
      instructions: Build the artifact.
    upload:
      allowedDirectories:
        - /srv/api
    restart:
      instructions: Restart the API.
    verify:
      instructions: Check the API.
---
`);
		const plan = await service.proposeForAgent("session-1", "planning-agent", "deploy-example.org.md", "api", {
			buildSteps: [{ workdir: ".", command: "node -e \"require('node:fs').writeFileSync('artifact.tar.gz','data')\"" }],
			artifacts: [{ source: "artifact.tar.gz", target: "/srv/api/artifact.tar.gz" }],
			restart: { command: "systemctl restart api" }, verify: { command: "systemctl is-active api" },
		}, agentSignal());
		approveDeployment(service, plan.id);
		await service.claimForAgent("session-1", plan.id, AGENT_RUN_ID);
		for (const stage of ["build", "upload", "restart"] as const)
			await service.executeStageForAgent("session-1", plan.id, AGENT_RUN_ID, stage, agentSignal());
		const failed = service.get("session-1", plan.id);
		expect(failed.status).toBe("recovering");
		expect(failed.stages.restart.status).toBe("failed");
		expect(upload).toHaveBeenCalledOnce();
		const oldApprovalId = failed.fullAccessApprovals?.restart?.id;
		const proposed = await service.proposeRecoveryForAgent("session-1", plan.id, AGENT_RUN_ID, 1, {
			stage: "restart", reason: "Retry with the corrected service name", command: "systemctl restart api-corrected",
		}, agentSignal());
		await service.decideRecovery("session-1", plan.id, proposed.recoveries!.at(-1)!.id, true);
		const pending = service.get("session-1", plan.id);
		expect(pending.fullAccessApprovals?.restart?.id).not.toBe(oldApprovalId);
		expect(() => service.decideFullAccess("session-1", plan.id, "restart", oldApprovalId!, true))
			.toThrowError(/does not match/);
		remoteFailureRef.current = false;
		approveDeployment(service, plan.id);
		await service.claimForAgent("session-1", plan.id, "agent-run-2");
		await service.executeStageForAgent("session-1", plan.id, "agent-run-2", "restart", agentSignal());
		await service.executeStageForAgent("session-1", plan.id, "agent-run-2", "verify", agentSignal());
		expect(service.get("session-1", plan.id).status).toBe("success");
		expect(upload).toHaveBeenCalledOnce();
		expect(submit.mock.calls.map(([input]) => input.toolCallId)).toEqual([
			`deploy:${plan.id}:r1:restart`, `deploy:${plan.id}:r2:restart`, `deploy:${plan.id}:r2:verify`,
		]);
		await service.close(); database.close();
	});
	it("freezes a model-proposed multi-artifact release and executes only after exact remote approvals", async () => {
		const { service, database, root, upload, submit } = await harness();
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
      instructions: Restart the API after all jars are uploaded.
    verify:
      instructions: Verify API health.
---
`);
		const proposal = {
			buildSteps: [{ workdir: ".", command: "node -e \"const fs=require('node:fs');fs.writeFileSync('common.jar','data');fs.writeFileSync('api.jar','data')\"" }],
			artifacts: [
				{ source: "common.jar", target: "/srv/api/lib/common.jar" },
				{ source: "api.jar", target: "/srv/api/lib/api.jar" },
			],
			restart: { command: "systemctl restart api" },
			verify: { command: "systemctl is-active api" },
		};
		await expect(service.prepare("session-1", "deploy-example.org.md", "api")).rejects.toMatchObject({ code: "deployment_agent_required" });
		const run = await service.proposeForAgent("session-1", "planning-agent-1", "deploy-example.org.md", "api", proposal, agentSignal());
		expect(run.plan).toMatchObject({ version: 2, artifacts: [{ remotePath: "/srv/api/lib/common.jar" }, { remotePath: "/srv/api/lib/api.jar" }] });
		expect((await service.proposeForAgent("session-1", "planning-agent-1", "deploy-example.org.md", "api", proposal, agentSignal())).id).toBe(run.id);
		await expect(service.proposeForAgent("session-1", "planning-agent-1", "deploy-example.org.md", "api", { ...proposal, restart: { command: "systemctl restart another" } }, agentSignal()))
			.rejects.toMatchObject({ code: "deployment_proposal_conflict" });
		await expect(service.claimForAgent("session-1", run.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		expect(upload).not.toHaveBeenCalled();
		approveDeployment(service, run.id);
		const finished = await claimAndRun(service, run.id);
		expect(finished.status).toBe("success");
		expect(finished.stages.upload.progress).toEqual({ current: 8, total: 8 });
		expect(upload).toHaveBeenCalledTimes(2);
		expect(submit).toHaveBeenCalledTimes(2);
		const abandoned = await service.proposeForAgent("session-1", "planning-agent-2", "deploy-example.org.md", "api", proposal, agentSignal());
		await service.finishPlanningAgent("session-1", "planning-agent-2", "cancelled");
		expect(service.get("session-1", abandoned.id)).toMatchObject({ status: "cancelled" });
		await expect(service.claimForAgent("session-1", abandoned.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_agent_mismatch" });
		await service.close(); database.close();
	});

	it("rejects model upload targets outside the profile and duplicate destinations before creating a plan", async () => {
		const { service, root, database, upload } = await harness();
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
      instructions: Build the service.
    upload:
      allowedDirectories:
        - /srv/api/lib
    restart:
      instructions: Restart the service.
---
`);
		const base = { buildSteps: [{ workdir: ".", command: "true" }], artifacts: [{ source: "api.jar", target: "/srv/api/lib/api.jar" }], restart: { command: "systemctl restart api" } };
		await expect(service.proposeForAgent("session-1", "planner-outside", "deploy-example.org.md", "api", {
			...base, artifacts: [{ source: "api.jar", target: "/srv/api/other/api.jar" }],
		}, agentSignal())).rejects.toMatchObject({ code: "deployment_upload_outside_profile" });
		await expect(service.proposeForAgent("session-1", "planner-duplicate", "deploy-example.org.md", "api", {
			...base, artifacts: [...base.artifacts, { source: "other.jar", target: "/srv/api/lib/api.jar" }],
		}, agentSignal())).rejects.toMatchObject({ code: "deployment_proposal_invalid" });
		await expect(service.proposeForAgent("session-1", "planner-write-path", "deploy-example.org.md", "api", {
			...base, restart: { command: "systemctl restart api", writePaths: ["/srv/api/../etc/service.conf"] },
		}, agentSignal())).rejects.toMatchObject({ code: "deployment_proposal_invalid" });
		expect(upload).not.toHaveBeenCalled();
		await service.close(); database.close();
	});
	it("builds, uploads, then runs approved Full Access restart and verify", async () => {
		const { service, upload, submit, database } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		expect(run.status).toBe("preparing");
		const finished = await claimAndRun(service, run.id);
		expect(finished.status).toBe("success");
		expect(upload).toHaveBeenCalledTimes(1);
		expect(submit).toHaveBeenCalledTimes(2);
		expect(run.plan.remoteAccess).toEqual({ mode: "full_access", reason: "sandbox_unavailable" });
		expect(submit).toHaveBeenCalledWith(expect.objectContaining({ sandboxPermissions: "full_access", command: "systemctl restart api" }));
		await service.close(); database.close();
	});

	it("refuses a mismatched host and remote destination outside the writable root", async () => {
		const wrongHost = await harness({ host: "other.example.org" });
		await expect(wrongHost.service.prepare("session-1", "deploy-example.org.md", "api")).rejects.toThrow("current Workspace host");
		await wrongHost.service.close(); wrongHost.database.close();
		const wrongRoot = await harness({ remoteRoot: "/srv/other" });
		await expect(wrongRoot.service.prepare("session-1", "deploy-example.org.md", "api")).rejects.toThrow("inside the remote Workspace directory");
		await wrongRoot.service.close(); wrongRoot.database.close();
	});

	it("stops before a remote command blocked by Guard", async () => {
		const { service, database, submit } = await harness({ guard: false });
		await expect(service.prepare("session-1", "deploy-example.org.md", "api")).rejects.toThrow("Guard blocked");
		expect(submit).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it("requires separate human approval for each deployment command before any side effect", async () => {
		const { service, database, root, upload, submit } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		expect(run.plan.remoteAccess).toEqual({ mode: "full_access", reason: "sandbox_unavailable" });
		await expect(service.claimForAgent("session-1", run.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		await expect(stat(join(root, "artifact.tar.gz"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(upload).not.toHaveBeenCalled();
		const restart = run.fullAccessApprovals?.restart;
		const verify = run.fullAccessApprovals?.verify;
		expect(restart?.status).toBe("pending");
		expect(verify?.status).toBe("pending");
		service.decideFullAccess("session-1", run.id, "restart", restart!.id, true);
		await expect(service.claimForAgent("session-1", run.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		service.decideFullAccess("session-1", run.id, "verify", verify!.id, true);
		expect((await claimAndRun(service, run.id)).status).toBe("success");
		expect(submit).toHaveBeenCalledTimes(2);
		expect(submit).toHaveBeenCalledWith(expect.objectContaining({ sandboxPermissions: "full_access", command: "systemctl restart api", fullAccessApprovalScopeId: `deployment:${run.id}` }));
		await service.close(); database.close();
	});

	it("lets a rejected approval cancel without uploading", async () => {
		const rejected = await harness();
		const run = await rejected.service.prepare("session-1", "deploy-example.org.md", "api");
		const approvalId = run.fullAccessApprovals!.restart!.id;
		expect(rejected.service.decideFullAccess("session-1", run.id, "restart", approvalId, false).status).toBe("cancelled");
		expect(rejected.service.decideFullAccess("session-1", run.id, "restart", approvalId, false).status).toBe("cancelled");
		expect(rejected.upload).not.toHaveBeenCalled();
		expect(rejected.submit).not.toHaveBeenCalled();
		await rejected.service.close(); rejected.database.close();
	});

	it("expires a Full Access decision and requires a fresh explicit approval", async () => {
		const { service, repository, database } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		for (const stage of ["restart", "verify"] as const)
			service.decideFullAccess("session-1", run.id, stage, run.fullAccessApprovals![stage]!.id, true);
		const stale = service.get("session-1", run.id);
		for (const approval of Object.values(stale.fullAccessApprovals ?? {})) {
			if (!approval) continue;
			approval.resolvedAt = Date.now() - 10 * 60_000;
			approval.expiresAt = approval.resolvedAt + 5 * 60_000;
		}
		repository.update(stale);
		await expect(service.claimForAgent("session-1", run.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		for (const stage of ["restart", "verify"] as const)
			service.decideFullAccess("session-1", run.id, stage, run.fullAccessApprovals![stage]!.id, true);
		expect((await claimAndRun(service, run.id)).status).toBe("success");
		await service.close(); database.close();
	});

	it("does not overwrite a newer approval snapshot", async () => {
		const { service, repository, database } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		const stale = service.get("session-1", run.id);
		service.decideFullAccess("session-1", run.id, "restart", run.fullAccessApprovals!.restart!.id, true);
		stale.updatedAt += 1;
		expect(repository.approvePreparing(stale, run.updatedAt)).toBe(false);
		expect(repository.find("session-1", run.id)?.fullAccessApprovals?.restart?.status).toBe("approved");
		await service.close(); database.close();
	});

	it("refuses an upload if the transfer resolved a different SSH host", async () => {
		const { service, database, upload, submit } = await harness({ transferHost: "changed.example.org" });
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		const finished = await claimAndRun(service, run.id);
		expect(finished).toMatchObject({ status: "failed", stages: { upload: { status: "failed" } } });
		expect(upload).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it("rejects a changed profile before any stage can run", async () => {
		const { service, database, root, upload } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		await writeFile(join(root, ".gori", "deploy-example.org.md"), "---\nversion: 2\n---\n");
		await expect(service.claimForAgent("session-1", run.id, AGENT_RUN_ID)).rejects.toThrow();
		expect(service.get("session-1", run.id).status).toBe("preparing");
		expect(upload).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it.each(["workspaceRevision", "hostKeyAlgorithm"] as const)("requires a new plan when %s changes after approval", async (field) => {
		const { service, database, target, upload } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		for (const stage of ["restart", "verify"] as const)
			service.decideFullAccess("session-1", run.id, stage, run.fullAccessApprovals![stage]!.id, true);
		if (field === "workspaceRevision") target.workspaceRevision += 1;
		else target.hostKeyAlgorithm = "rsa-sha2-512";
		await expect(service.claimForAgent("session-1", run.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_target_mismatch" });
		expect(upload).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it("claims one Agent Run and makes repeated or cancelled requests stable", async () => {
		const { service, database, submit } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		await Promise.all([service.claimForAgent("session-1", run.id, AGENT_RUN_ID), service.claimForAgent("session-1", run.id, AGENT_RUN_ID)]);
		expect((await runStages(service, run.id)).status).toBe("success");
		expect(submit).toHaveBeenCalledTimes(2);
		const cancelled = await service.prepare("session-1", "deploy-example.org.md", "api");
		expect((await service.cancel("session-1", cancelled.id)).status).toBe("cancelled");
		await expect(service.claimForAgent("session-1", cancelled.id, AGENT_RUN_ID)).rejects.toMatchObject({ code: "deployment_agent_mismatch" });
		await service.close(); database.close();
	});

	it("returns a conflict when another deployment owns the Session", async () => {
		const { service, database } = await harness({ buildCommand: "node -e \"setTimeout(() => {}, 10000)\"" });
		const first = await service.prepare("session-1", "deploy-example.org.md", "api");
		const second = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, first.id);
		approveDeployment(service, second.id);
		await service.claimForAgent("session-1", first.id, AGENT_RUN_ID);
		await expect(service.claimForAgent("session-1", second.id, "agent-run-2")).rejects.toThrow("Another deployment is running");
		expect(service.get("session-1", second.id).status).toBe("preparing");
		await service.cancel("session-1", first.id);
		await service.cancel("session-1", second.id);
		await service.close(); database.close();
	});

	it("serializes deployments across Sessions that share one Workspace", async () => {
		const { service, database } = await harness();
		database.exec(`INSERT INTO sessions (id, workspace_id, display_name, terminal_context_cursor, revision, created_at, updated_at)
			VALUES ('session-2', 'workspace-1', 'second', 0, 1, 2, 2)`);
		const first = await service.prepare("session-1", "deploy-example.org.md", "api");
		const second = await service.prepare("session-2", "deploy-example.org.md", "api");
		approveDeployment(service, first.id);
		approveDeployment(service, second.id, "session-2");
		await service.claimForAgent("session-1", first.id, AGENT_RUN_ID);
		await expect(service.claimForAgent("session-2", second.id, "agent-run-2")).rejects.toMatchObject({ code: "deployment_workspace_busy" });
		expect(service.get("session-2", second.id).status).toBe("preparing");
		await service.finishAgent("session-1", first.id, AGENT_RUN_ID, "cancelled");
		expect((await service.claimForAgent("session-2", second.id, "agent-run-2")).status).toBe("running");
		await service.finishAgent("session-2", second.id, "agent-run-2", "cancelled");
		await service.close(); database.close();
	});

	it("stops after a failed restart without running verification", async () => {
		const { service, database, submit } = await harness({ remoteFails: true });
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		const finished = await claimAndRun(service, run.id);
		expect(finished).toMatchObject({ status: "failed", stages: { restart: { status: "failed" }, verify: { status: "pending" } } });
		expect(submit).toHaveBeenCalledTimes(1);
		await service.close(); database.close();
	});

	it("holds the Session lease while building and releases it on cancellation", async () => {
		const { service, database, lifecycle } = await harness({ buildCommand: "node -e \"setTimeout(() => {}, 10000)\"" });
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		await service.claimForAgent("session-1", run.id, AGENT_RUN_ID);
		const stage = service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "build", agentSignal());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(lifecycle.getUsage("session-1").byKind.deployment_run).toBe(1);
		expect((await service.cancel("session-1", run.id)).status).toBe("cancelled");
		await stage;
		expect(lifecycle.getUsage("session-1").byKind.deployment_run).toBe(0);
		await service.close(); database.close();
	});

	it("settles a persisted running stage after repeated stage-save failures", async () => {
		const { service, repository, database } = await harness({
			buildCommand: "node -e \"console.log('built');require('node:fs').writeFileSync('artifact.tar.gz','data')\"",
		});
		const prepared = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, prepared.id);
		await service.claimForAgent("session-1", prepared.id, AGENT_RUN_ID);
		const update = repository.update.bind(repository);
		let failuresRemaining = 2;
		vi.spyOn(repository, "update").mockImplementation((run) => {
			if (run.stages.build.status !== "running" && failuresRemaining-- > 0)
				throw new Error("injected stage persistence failure");
			update(run);
		});
		await expect(service.executeStageForAgent("session-1", prepared.id, AGENT_RUN_ID, "build", agentSignal()))
			.rejects.toThrow("injected stage persistence failure");
		expect(repository.find("session-1", prepared.id)).toMatchObject({
			status: "running", stages: { build: { status: "running", log: expect.stringContaining("built") } },
		});
		await service.finishAgent("session-1", prepared.id, AGENT_RUN_ID, "failed");
		const settled = repository.find("session-1", prepared.id);
		expect(settled).toMatchObject({ status: "failed", stages: { build: {
			status: "failed", log: expect.stringContaining("built"),
			error: expect.stringContaining("inspect effects before retrying"),
		} } });
		expect(settled?.stages.build.finishedAt).toBeGreaterThanOrEqual(settled?.stages.build.startedAt ?? 0);
		await service.close(); database.close();
	});

	it("still cancels the Agent Run when deployment settlement cannot be saved", async () => {
		const cancelAgentRun = vi.fn(async (_sessionId: string, _agentRunId: string) => {});
		const { service, repository, database } = await harness({ cancelAgentRun });
		const prepared = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, prepared.id);
		await service.claimForAgent("session-1", prepared.id, AGENT_RUN_ID);
		const update = vi.spyOn(repository, "update").mockImplementation(() => {
			throw new Error("injected settlement persistence failure");
		});
		await expect(service.cancel("session-1", prepared.id)).rejects.toThrow("injected settlement persistence failure");
		expect(cancelAgentRun).toHaveBeenCalledExactlyOnceWith("session-1", AGENT_RUN_ID);
		update.mockRestore();
		await service.finishAgent("session-1", prepared.id, AGENT_RUN_ID, "cancelled");
		await service.close(); database.close();
	});

	it("marks an in-progress run failed after restart", async () => {
		const { service, repository, database } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		run.status = "running";
		run.stages.build = { status: "running", log: "building" };
		repository.update(run);
		repository.recoverInterrupted(Date.now());
		expect(repository.find("session-1", run.id)).toMatchObject({ status: "failed", stages: { build: { status: "failed" } } });
		await service.close(); database.close();
	});

	it("invalidates an unconfirmed plan after restart without claiming remote side effects", async () => {
		const { service, repository, database } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		repository.recoverInterrupted(Date.now());
		const recovered = repository.find("session-1", run.id);
		expect(recovered).toMatchObject({ status: "cancelled", stages: { build: { status: "pending" }, upload: { status: "pending" } } });
		expect(recovered?.error).toContain("No deployment stages were started");
		await service.close(); database.close();
	});

	it("keeps claim time monotonic if the system clock moves backwards", async () => {
		const { service, database } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		const clock = vi.spyOn(Date, "now").mockReturnValue(run.createdAt - 1_000);
		try {
			const claimed = await service.claimForAgent("session-1", run.id, AGENT_RUN_ID);
			expect(claimed.startedAt).toBe(run.createdAt);
			expect(service.get("session-1", run.id).startedAt).toBe(run.createdAt);
		} finally { clock.mockRestore(); }
		await service.finishAgent("session-1", run.id, AGENT_RUN_ID, "cancelled");
		await service.close(); database.close();
	});

	it("claims an Agent Run without executing stages and rejects a different Agent", async () => {
		const { service, database, root, upload, submit } = await harness();
		const prepared = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, prepared.id);
		const claimed = await service.claimForAgent("session-1", prepared.id, AGENT_RUN_ID);
		expect(claimed).toMatchObject({ status: "running", agentRunId: AGENT_RUN_ID, stages: { build: { status: "pending" } } });
		await expect(stat(join(root, "artifact.tar.gz"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(upload).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		await expect(service.executeStageForAgent("session-1", prepared.id, "other-agent", "build", agentSignal())).rejects.toMatchObject({ code: "deployment_agent_mismatch" });
		await expect(service.claimForAgent("session-1", prepared.id, "other-agent")).rejects.toMatchObject({ code: "deployment_agent_mismatch" });
		await service.finishAgent("session-1", prepared.id, AGENT_RUN_ID, "completed");
		expect(service.get("session-1", prepared.id)).toMatchObject({ status: "failed", stages: { build: { status: "pending" } } });
		await service.close(); database.close();
	});

	it("enforces stage order and joins concurrent requests for the same stage", async () => {
		let releaseUpload!: () => void;
		const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
		const { service, database, upload, submit } = await harness({ uploadGate });
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		await service.claimForAgent("session-1", run.id, AGENT_RUN_ID);
		await expect(service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "restart", agentSignal())).rejects.toMatchObject({ code: "deployment_stage_out_of_order" });
		const built = await service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "build", agentSignal());
		expect((await service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "build", agentSignal())).stages.build).toEqual(built.stages.build);
		const first = service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "upload", agentSignal());
		const second = service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "upload", agentSignal());
		await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
		await expect(service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "restart", agentSignal())).rejects.toMatchObject({ code: "deployment_stage_busy" });
		releaseUpload();
		await Promise.all([first, second]);
		expect(upload).toHaveBeenCalledTimes(1);
		expect(submit).not.toHaveBeenCalled();
		await service.finishAgent("session-1", run.id, AGENT_RUN_ID, "failed");
		await service.close(); database.close();
	});

	it("skips an absent verification command only when the Agent advances that final stage", async () => {
		const { service, database, submit } = await harness({ includeVerify: false });
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		const claimed = await service.claimForAgent("session-1", run.id, AGENT_RUN_ID);
		expect(claimed.plan.verify).toBeUndefined();
		const finished = await runStages(service, run.id);
		expect(finished).toMatchObject({ status: "success", stages: { verify: { status: "skipped" } } });
		expect(submit).toHaveBeenCalledTimes(1);
		await service.close(); database.close();
	});

	it("returns the failed stage snapshot and never retries its command", async () => {
		const { service, database, submit } = await harness({ remoteFails: true });
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		await service.claimForAgent("session-1", run.id, AGENT_RUN_ID);
		for (const stage of ["build", "upload"] as const) await service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, stage, agentSignal());
		const failed = await service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "restart", agentSignal());
		expect(failed).toMatchObject({ status: "failed", stages: { restart: {
			status: "failed", exitCode: 1, failureCode: "remote_exit_non_zero",
			safeDetails: { exitCode: 1, commandMayHaveRun: true }, operationId: `operation-deploy:${run.id}:restart`,
		}, verify: { status: "pending" } } });
		expect(await service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "restart", agentSignal())).toEqual(failed);
		expect(submit).toHaveBeenCalledTimes(1);
		await service.close(); database.close();
	});

	it("rejects Profile changes between Agent stages before another side effect", async () => {
		const { service, database, root, upload, submit } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		approveDeployment(service, run.id);
		await service.claimForAgent("session-1", run.id, AGENT_RUN_ID);
		await service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "build", agentSignal());
		await writeFile(join(root, ".gori", "deploy-example.org.md"), "---\nversion: 2\n---\n");
		const failed = await service.executeStageForAgent("session-1", run.id, AGENT_RUN_ID, "upload", agentSignal());
		expect(failed).toMatchObject({ status: "failed", stages: { upload: { status: "failed" } } });
		expect(upload).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		await service.close(); database.close();
	});

	it("pages complete deployment history for the Session without silently truncating older runs", async () => {
		const { service, repository, database } = await harness();
		const first = await service.prepare("session-1", "deploy-example.org.md", "api");
		const second = await service.prepare("session-1", "deploy-example.org.md", "api");
		const page = service.listHistory("session-1", 1);
		expect(page).toMatchObject({ hasMore: true, runs: [{ stages: { prepare: { status: "success" } } }] });
		expect(page.nextCursor).toBeTypeOf("string");
		const older = service.listHistory("session-1", 1, page.nextCursor!);
		expect(older).toMatchObject({ hasMore: false, nextCursor: null });
		expect([page.runs[0]!.id, older.runs[0]!.id].sort()).toEqual([first.id, second.id].sort());
		expect(service.listHistory("other-session").runs).toEqual([]);
		expect(() => service.listHistory("other-session", 1, page.nextCursor!)).toThrow("cursor is invalid");
		expect(() => service.listHistory("session-1", 1, "tampered!")).toThrow("cursor is invalid");
		expect(() => repository.listRecent("session-1", 0)).toThrow();
		await service.close(); database.close();
	});

	it("keeps a deployment on its original history page when claimed between page requests", async () => {
		const { service, repository, database } = await harness();
		const clock = vi.spyOn(Date, "now");
		let early!: DeploymentRun;
		let later!: DeploymentRun;
		try {
			clock.mockReturnValue(1_000);
			early = await service.prepare("session-1", "deploy-example.org.md", "api");
			clock.mockReturnValue(2_000);
			later = await service.prepare("session-1", "deploy-example.org.md", "api");
			const newest = service.listHistory("session-1", 1);
			expect(newest.runs.map(({ id }) => id)).toEqual([later.id]);
			expect(newest.hasMore).toBe(true);
			clock.mockReturnValue(3_000);
			approveDeployment(service, early.id);
			await service.claimForAgent("session-1", early.id, AGENT_RUN_ID);
			expect(service.listHistory("session-1", 1, newest.nextCursor!).runs.map(({ id }) => id)).toEqual([early.id]);
		} finally { clock.mockRestore(); }
		expect(repository.latest("session-1")?.id).toBe(later.id);
		await service.finishAgent("session-1", early.id, AGENT_RUN_ID, "cancelled");
		await service.close(); database.close();
	});

	it("keeps legacy deployment history at creation time even after its build starts", async () => {
		const { service, repository, database } = await harness();
		const clock = vi.spyOn(Date, "now");
		let early!: DeploymentRun;
		let later!: DeploymentRun;
		try {
			clock.mockReturnValue(1_000);
			early = await service.prepare("session-1", "deploy-example.org.md", "api");
			clock.mockReturnValue(2_000);
			later = await service.prepare("session-1", "deploy-example.org.md", "api");
		} finally { clock.mockRestore(); }
		const legacy = structuredClone(early);
		legacy.status = "failed";
		legacy.stages.build = { status: "failed", log: "build failed", startedAt: 3_000, finishedAt: 3_001, error: "build failed" };
		legacy.finishedAt = 3_001;
		legacy.updatedAt = 3_001;
		repository.update(legacy);
		const newest = service.listHistory("session-1", 1);
		expect(newest.runs.map(({ id }) => id)).toEqual([later.id]);
		expect(service.listHistory("session-1", 1, newest.nextCursor!).runs.map(({ id }) => id)).toEqual([early.id]);
		await service.close(); database.close();
	});

	it("rejects a damaged persisted plan before it reaches the runtime", async () => {
		const { service, repository, database } = await harness();
		const run = await service.prepare("session-1", "deploy-example.org.md", "api");
		database.prepare("UPDATE deployment_runs SET snapshot_json = json_remove(snapshot_json, '$.plan.build.command') WHERE id = ?").run(run.id);
		expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
		repository.update(run);
		database.prepare("UPDATE deployment_runs SET snapshot_json = json_set(snapshot_json, '$.plan.remoteAccess', json('null')) WHERE id = ?").run(run.id);
		expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
		repository.update(run);
		database.prepare("UPDATE deployment_runs SET snapshot_json = json_set(snapshot_json, '$.plan.remoteAccess.reason', 'unknown') WHERE id = ?").run(run.id);
		expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
		repository.update(run);
		database.prepare("UPDATE deployment_runs SET snapshot_json = json_set(snapshot_json, '$.agentRunId', 42) WHERE id = ?").run(run.id);
		expect(() => repository.find("session-1", run.id)).toThrow("Saved deployment run is invalid");
		await service.close(); database.close();
	});

	it("rejects damaged Agent binding timestamps and unsafe diagnostic detail shapes", async () => {
		const { service, repository, database } = await harness({ remoteFails: true });
		const plan = await service.prepare("session-1", "deploy-example.org.md", "api");
		const failed = await claimAndRun(service, plan.id);
		database.prepare("UPDATE deployment_runs SET snapshot_json = json_remove(snapshot_json, '$.startedAt') WHERE id = ?").run(plan.id);
		expect(() => repository.find("session-1", plan.id)).toThrow("Saved deployment run is invalid");
		repository.update(failed);
		database.prepare("UPDATE deployment_runs SET snapshot_json = json_set(snapshot_json, '$.stages.restart.safeDetails', json('{\"nested\":{\"secret\":\"x\"}}')) WHERE id = ?").run(plan.id);
		expect(() => repository.find("session-1", plan.id)).toThrow("Saved deployment run is invalid");
		repository.update(failed);
		expect(repository.find("session-1", plan.id)?.stages.restart).toMatchObject({ failureCode: "remote_exit_non_zero", exitCode: 1 });
		await service.close(); database.close();
	});

	it("rejects phase-skipping or contradictory persisted stage snapshots", async () => {
		const { service, repository, database } = await harness();
		const base = await service.prepare("session-1", "deploy-example.org.md", "api");
		const invalid: Array<[string, (run: DeploymentRun) => void]> = [
			["preparing with build already done", (run) => { run.stages.build.status = "success"; }],
			["running with upload done before build", (run) => { run.status = "running"; run.stages.upload.status = "success"; }],
			["running with a failed stage", (run) => { run.status = "running"; run.stages.build.status = "failed"; }],
			["success with pending verification", (run) => { run.status = "success"; }],
			["failed with a running stage", (run) => { run.status = "failed"; run.stages.build.status = "running"; }],
			["cancelled with a gap before upload", (run) => { run.status = "cancelled"; run.stages.upload.status = "success"; }],
			["configured verification skipped", (run) => {
				run.status = "success";
				for (const stage of ["build", "upload", "restart"] as const) run.stages[stage].status = "success";
				run.stages.verify.status = "skipped";
			}],
		];
		for (const [label, change] of invalid) {
			const run = structuredClone(base);
			change(run);
			repository.update(run);
			expect(() => repository.find("session-1", run.id), label).toThrow("Saved deployment run is invalid");
		}
		await service.close(); database.close();
	});

	it("accepts valid legacy v23 prefixes and interrupted recovery without Agent timestamps", async () => {
		const { service, repository, database } = await harness();
		const base = await service.prepare("session-1", "deploy-example.org.md", "api");
		const states: Array<[string, (run: DeploymentRun) => void]> = [
			["preparing", () => undefined],
			["running in upload", (run) => { run.status = "running"; run.stages.build.status = "success"; run.stages.upload.status = "running"; }],
			["successful", (run) => { run.status = "success"; for (const stage of ["build", "upload", "restart", "verify"] as const) run.stages[stage].status = "success"; }],
			["failed between stages", (run) => { run.status = "failed"; run.stages.build.status = "success"; }],
			["cancelled before build", (run) => { run.status = "cancelled"; }],
		];
		for (const [label, change] of states) {
			const run = structuredClone(base);
			change(run);
			repository.update(run);
			expect(repository.find("session-1", run.id), label).toMatchObject({ status: run.status });
		}
		const interrupted = structuredClone(base);
		interrupted.status = "running";
		interrupted.stages.build.status = "success";
		interrupted.stages.upload.status = "running";
		repository.update(interrupted);
		repository.recoverInterrupted(Date.now());
		expect(repository.find("session-1", base.id)).toMatchObject({ status: "failed", stages: { upload: { status: "failed" } } });
		await service.close(); database.close();
	});

	it("upgrades a v22 database without changing existing sessions", async () => {
		const { service, database } = await harness();
		await service.close();
		database.exec("DROP TABLE deployment_runs; DELETE FROM ssh_agent_schema_migrations WHERE version = 23");
		applyMigrations(database);
		expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toMatchObject({ count: 1 });
		expect(database.prepare("SELECT version FROM ssh_agent_schema_migrations WHERE version = 23").get()).toMatchObject({ version: 23 });
		applyMigrations(database);
		database.close();
	});
});
