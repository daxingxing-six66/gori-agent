import { describe, expect, it, vi } from "vitest";
import { parseCreateChatRun } from "../src/api/request-validation.ts";
import { createDeploymentAgentTools, type AgentDeploymentService } from "../src/application/tools/deployment-agent-tool.ts";
import type { DeploymentRun } from "../src/domain/deployment.ts";

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
	const deployments: AgentDeploymentService = {
		get,
		claimForAgent: vi.fn(async () => run),
		executeStageForAgent,
		finishAgent: vi.fn(async () => undefined),
	};
	return { deployments, get, executeStageForAgent };
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
		expect(executeStageForAgent).toHaveBeenCalledWith("session-1", "deploy-1", "agent-1", "build", signal);
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
});
