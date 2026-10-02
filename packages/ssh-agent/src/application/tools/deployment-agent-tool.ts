import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { DEPLOY_STAGES, type DeploymentRun, type DeployStage } from "../../domain/deployment.ts";

type ExecutableDeploymentStage = Exclude<DeployStage, "prepare">;

/** The deployment service, rather than the model, owns commands and stage transitions. */
export interface AgentDeploymentService {
	get(sessionId: string, deploymentRunId: string): DeploymentRun;
	claimForAgent(sessionId: string, deploymentRunId: string, agentRunId: string): Promise<DeploymentRun>;
	executeStageForAgent(
		sessionId: string,
		deploymentRunId: string,
		agentRunId: string,
		stage: ExecutableDeploymentStage,
		signal: AbortSignal,
	): Promise<DeploymentRun>;
	finishAgent(sessionId: string, deploymentRunId: string, agentRunId: string, status: "completed" | "failed" | "cancelled"): Promise<void>;
}

const executeParameters = Type.Object({
	stage: Type.Union([Type.Literal("build"), Type.Literal("upload"), Type.Literal("restart"), Type.Literal("verify")]),
}, { additionalProperties: false });

export const deploymentInspectDefinition = {
	name: "deployment_inspect",
	label: "Inspect deployment",
	description: "Read the bound deployment plan and current stage results. This tool cannot execute or approve anything.",
	parameters: Type.Object({}, { additionalProperties: false }),
};

export const deploymentExecuteNextDefinition = {
	name: "deployment_execute_next",
	label: "Execute deployment stage",
	description: "Execute exactly one stage from the user-confirmed deployment plan. Supply only the stage name. The server verifies the Agent Run binding, required order, target, Guard, sandbox, and Full Access approvals. A failed stage is not retried automatically.",
	parameters: executeParameters,
};

export function createDeploymentAgentTools(input: {
	run: { id: string; sessionId: string };
	deploymentRunId: string;
	deployments: AgentDeploymentService;
}): AgentTool[] {
	const { run, deploymentRunId, deployments } = input;
	return [
		{
			...deploymentInspectDefinition,
			executionMode: "sequential",
			execute: async () => result(deployments.get(run.sessionId, deploymentRunId), true),
		},
		{
			...deploymentExecuteNextDefinition,
			executionMode: "sequential",
			execute: async (_toolCallId, params, signal) => {
				const stage = (params as { stage: ExecutableDeploymentStage }).stage;
				const snapshot = await deployments.executeStageForAgent(run.sessionId, deploymentRunId, run.id, stage, signal ?? new AbortController().signal);
				return result(snapshot, false, stage);
			},
		},
	];
}

function result(run: DeploymentRun, includePlan = false, logStage?: ExecutableDeploymentStage) {
	const stages = Object.fromEntries(DEPLOY_STAGES.map((stage) => {
		const view = run.stages[stage];
		return [stage, {
			status: view.status,
			...(view.error === undefined ? {} : { error: view.error }),
			...(view.exitCode === undefined ? {} : { exitCode: view.exitCode }),
			...(view.failureCode === undefined ? {} : { failureCode: view.failureCode }),
			...(view.operationId === undefined ? {} : { operationId: view.operationId }),
			...(view.safeDetails === undefined ? {} : { safeDetails: view.safeDetails }),
			...(view.progress === undefined ? {} : { progress: view.progress }),
			...(view.log.length === 0 || (logStage !== undefined && stage !== logStage)
				? {} : { logTail: view.log.slice(-8_192), logTruncated: view.log.length > 8_192 }),
		}];
	}));
	const nextStage = run.status === "running"
		? DEPLOY_STAGES.slice(1).find((stage) => run.stages[stage].status === "pending") ?? null
		: null;
	return {
		content: [{ type: "text" as const, text: JSON.stringify({
			deploymentRunId: run.id,
			status: run.status,
			nextStage,
			...(run.error === undefined ? {} : { error: run.error }),
			...(includePlan ? { plan: run.plan } : {}),
			stages,
		}) }],
		details: {},
	};
}
