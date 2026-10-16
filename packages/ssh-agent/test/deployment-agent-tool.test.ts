import { describe, expect, it, vi } from "vitest";
import { parseCreateChatRun } from "../src/api/request-validation.ts";
import { createDeploymentAgentTools, createDeploymentPlanningTool, createDeploymentRecoveryTools, type AgentDeploymentService, type DeploymentPlanProposal } from "../src/application/tools/deployment-agent-tool.ts";
import type { DeploymentDiscussion, DeploymentRun } from "../src/domain/deployment.ts";

function discussion(): DeploymentDiscussion {
	return {
		id: "discussion-1", sessionId: "session-1", workspaceId: "workspace-1", status: "discussing", revision: 2,
		profileFile: "deploy-host.md", profileHash: "hash", projectRoot: "/project", project: "project",
		module: { id: "api", name: "API" },
		targetBinding: { hostname: "host", port: 22, workspaceRevision: 1, hostKeyAlgorithm: "ssh-ed25519",
			hostKeyFingerprint: "fingerprint", credentialId: "credential-1", credentialAuthVersion: 1,
			remoteUser: "user", writableRoot: "/srv/project" },
		createdAt: 1, updatedAt: 1,
	};
}

function deployment(): DeploymentRun {
	return {
		id: "deploy-1", sessionId: "session-1", workspaceId: "workspace-1", status: "running",
		plan: {
			profilePath: "/project/.gori/deploy-host.md", profileHash: "hash", remoteAccess: { mode: "workspace_write" },
			project: "project", target: { host: "host" },
			targetBinding: { port: 22, hostKeyFingerprint: "fingerprint", credentialId: "credential-1", credentialAuthVersion: 1, remoteUser: "user", writableRoot: "/srv/project" },
			module: { id: "api", name: "API" },
			build: { cwd: "/project", command: "make build", artifact: "/project/api.tar" },
			upload: { remotePath: "/srv/project/api.tar" }, restart: { command: "systemctl restart api" },
			verify: { command: "systemctl is-active api" },
		},
		stages: {
			prepare: { status: "success", log: "" }, build: { status: "pending", log: "" },
			upload: { status: "pending", log: "" }, restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" },
		},
		createdAt: 1, updatedAt: 1,
	};
}

function service(run: DeploymentRun) {
	const get = vi.fn(() => run);
	const executeStageForAgent = vi.fn(async () => run);
	const proposeForDiscussion = vi.fn(async () => run);
	const deployments: AgentDeploymentService = {
		activeDiscussion: vi.fn(() => discussion()),
		getDiscussion: vi.fn(() => discussion()),
		bindPlanningRun: vi.fn(async () => discussion()),
		discussionInstructions: vi.fn(async () => "Discussion instructions"),
		proposeForDiscussion,
		get,
		bindRecoveryAgent: vi.fn(async () => run), proposeRecoveryForAgent: vi.fn(async () => run),
		claimForAgent: vi.fn(async () => run),
		executeStageForAgent,
		finishAgent: vi.fn(async () => undefined),
		finishPlanningAgent: vi.fn(async () => undefined),
	};
	return { deployments, get, executeStageForAgent, proposeForDiscussion };
}

describe("deployment Agent boundary", () => {
	it("requires an execution workflow with a bounded deployment Run ID", () => {
		const base = { requestId: "request-1", message: "Deploy", serverInteractionMode: "command" };
		expect(parseCreateChatRun({ ...base, workflow: "deployment_execution", deploymentRunId: "deploy-1" })).toMatchObject({
			workflow: "deployment_execution", deploymentRunId: "deploy-1",
		});
		expect(() => parseCreateChatRun({ ...base, workflow: "deployment_execution" })).toThrow();
		expect(() => parseCreateChatRun({ ...base, deploymentRunId: "deploy-1" })).toThrow();
		expect(() => parseCreateChatRun({ ...base, workflow: "deployment_setup", deploymentRunId: "deploy-1" })).toThrow();
		expect(() => parseCreateChatRun({ ...base, workflow: "deployment_execution", deploymentRunId: "../other" })).toThrow();
	});

	it("accepts only a persisted discussion ID for planning", () => {
		const base = { requestId: "request-1", message: "Plan release", serverInteractionMode: "command" };
		const planning = { workflow: "deployment_planning", deploymentDiscussionId: "discussion-1" };
		expect(parseCreateChatRun({ ...base, ...planning })).toMatchObject(planning);
		for (const invalid of [
			{ workflow: "deployment_planning" },
			{ ...planning, deploymentDiscussionId: "  " },
			{ ...planning, deploymentDiscussionId: "../other" },
			{ ...planning, deploymentRunId: "deploy-1" },
			{ deploymentDiscussionId: "discussion-1" },
			{ workflow: "deployment_planning", deploymentProfileFile: "deploy-host.md", deploymentModuleId: "api" },
		]) expect(() => parseCreateChatRun({ ...base, ...invalid })).toThrow();
	});

	it("binds a planning proposal to the persisted Discussion revision, Session and Agent Run", async () => {
		const run = deployment();
		run.status = "preparing";
		const { deployments, proposeForDiscussion } = service(run);
		const tool = createDeploymentPlanningTool({
			run: { id: "agent-1", sessionId: "session-1" }, discussionId: "discussion-1", revision: 2, deployments,
		});
		const proposal: DeploymentPlanProposal = {
			buildSteps: [{ workdir: "app", command: "mvn package" }],
			artifacts: [{ source: "app/target/api.jar", target: "/srv/project/api.jar" }],
			restart: { command: "systemctl restart api" },
		};
		const signal = new AbortController().signal;
		const result = await tool.execute("call-1", proposal, signal);
		expect(proposeForDiscussion).toHaveBeenCalledWith("session-1", "discussion-1", 2, "agent-1", proposal, signal);
		expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
			deploymentRunId: "deploy-1", status: "preparing", plan: { module: { id: "api" } },
		});
	});

	it("binds inspection and one stage execution to the server-owned Session and Agent Run", async () => {
		const run = deployment();
		const { deployments, get, executeStageForAgent } = service(run);
		const [inspect, execute] = createDeploymentAgentTools({
			run: { id: "agent-1", sessionId: "session-1" }, deploymentRunId: run.id, deployments,
		});
		const inspected = await inspect!.execute("call-1", {}, undefined);
		expect(get).toHaveBeenCalledWith("session-1", "deploy-1");
		expect(JSON.parse((inspected.content[0] as { text: string }).text)).toMatchObject({
			deploymentRunId: "deploy-1", nextStage: "build", stages: { build: { status: "pending" } },
		});
		const signal = new AbortController().signal;
		await execute!.execute("call-2", { stage: "build" }, signal);
		expect(executeStageForAgent).toHaveBeenCalledWith("session-1", "deploy-1", "agent-1", "build", signal, "call-2");
	});

	it("returns a failed stage as diagnostic data without suggesting another stage", async () => {
		const run = deployment();
		run.status = "failed";
		run.error = "Restart failed";
		run.stages.build = { status: "success", log: "Build complete" };
		run.stages.upload = { status: "success", log: "Uploaded" };
		run.stages.restart = { status: "failed", log: "x".repeat(10_000), error: "Exit 1", exitCode: 1,
			failureCode: "remote_exit_non_zero", operationId: "operation-1", safeDetails: { commandMayHaveRun: true } };
		const { deployments } = service(run);
		const [inspect] = createDeploymentAgentTools({
			run: { id: "agent-1", sessionId: "session-1" }, deploymentRunId: run.id, deployments,
		});
		const result = await inspect!.execute("call-1", {}, undefined);
		const output = JSON.parse((result.content[0] as { text: string }).text);
		expect(output.nextStage).toBeNull();
		expect(output.stages.restart).toMatchObject({ status: "failed", error: "Exit 1", logTruncated: true,
			exitCode: 1, failureCode: "remote_exit_non_zero", operationId: "operation-1", safeDetails: { commandMayHaveRun: true } });
		expect(output.stages.restart.logTail).toHaveLength(8_192);
	});

	it("allows a recovery Run to inspect, retry the confirmed plan and propose reviewed changes", async () => {
		const run = deployment();
		run.status = "recovering";
		run.stages.build = { status: "failed", log: "compiler error", error: "Build exited with status 1" };
		const { deployments, executeStageForAgent } = service(run);
		const tools = createDeploymentRecoveryTools({
			run: { id: "agent-repair", sessionId: "session-1" }, deploymentRunId: run.id, deployments,
		});
		expect(tools.map((tool) => tool.name)).toEqual(["deployment_inspect", "deployment_execute_next", "deployment_propose_recovery"]);
		const input = { expectedRevision: 1, stage: "build", reason: "Use the correct build goal",
			buildSteps: [{ workdir: ".", command: "mvn package" }] };
		await tools[2]!.execute("call-repair", input, undefined);
		expect(deployments.proposeRecoveryForAgent).toHaveBeenCalledWith("session-1", "deploy-1", "agent-repair", 1,
			{ stage: "build", reason: input.reason, buildSteps: input.buildSteps }, expect.any(AbortSignal));
		expect(executeStageForAgent).not.toHaveBeenCalled();
	});
});
