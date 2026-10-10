import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { DEPLOY_STAGES, type DeploymentDiscussion, type DeploymentRun, type DeployStage } from "../../domain/deployment.ts";
import type { DeploymentPlanProposal } from "../deployment-plan-proposal.ts";
import type { DeploymentRecoveryInput } from "../deployment-recovery-proposal.ts";
import { backendMessage } from "../../i18n/message.ts";
import { isToolArguments, type PreparedToolAuthorization, type ToolAuthorizationInput } from "./tool-authorization.ts";

export type { DeploymentPlanProposal } from "../deployment-plan-proposal.ts";

type ExecutableDeploymentStage = Exclude<DeployStage, "prepare">;

/** The deployment service, rather than the model, owns commands and stage transitions. */
export interface AgentDeploymentService {
	activeDiscussion(sessionId: string): DeploymentDiscussion | null;
	getDiscussion(sessionId: string, discussionId: string): DeploymentDiscussion;
	bindPlanningRun(sessionId: string, discussionId: string, agentRunId: string): Promise<DeploymentDiscussion>;
	discussionInstructions(sessionId: string, discussionId: string): Promise<string>;
	proposeForDiscussion(sessionId: string, discussionId: string, expectedRevision: number, agentRunId: string,
		proposal: DeploymentPlanProposal, signal: AbortSignal): Promise<DeploymentRun>;
	finishPlanningAgent(sessionId: string, agentRunId: string, status: "failed" | "cancelled"): Promise<void>;
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
	bindRecoveryAgent(sessionId: string, deploymentRunId: string, agentRunId: string): Promise<DeploymentRun>;
	proposeRecoveryForAgent(sessionId: string, deploymentRunId: string, agentRunId: string, expectedRevision: number,
		input: DeploymentRecoveryInput, signal: AbortSignal): Promise<DeploymentRun>;
}

const executeParameters = Type.Object({
	stage: Type.Union([Type.Literal("build"), Type.Literal("upload"), Type.Literal("restart"), Type.Literal("verify")]),
}, { additionalProperties: false });

const commandParameters = Type.Object({
	command: Type.String({ minLength: 1, maxLength: 4_000 }),
	writePaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { minItems: 1, maxItems: 16 })),
}, { additionalProperties: false });

export async function prepareDeploymentStageAuthorization(input: ToolAuthorizationInput, options: {
	deploymentRunId?: string;
	autoApprove(): Promise<boolean>;
	previewRemoteStage?: (sessionId: string, deploymentRunId: string, stage: "restart" | "verify") =>
		{ readonly command: string; readonly mode: "workspace_write" | "full_access"; readonly sessionAuthorized?: boolean } | undefined;
}): Promise<PreparedToolAuthorization> {
	const stage = isToolArguments(input.args) ? input.args.stage : undefined;
	if ((stage !== "restart" && stage !== "verify") || !options.deploymentRunId) return { kind: "allow" };
	const preview = options.previewRemoteStage?.(input.run.sessionId, options.deploymentRunId, stage);
	if (!preview || (preview.mode === "full_access" && !preview.sessionAuthorized)) return { kind: "allow" };
	return { kind: "approval", autoApprove: await options.autoApprove(),
		descriptionMessage: preview.sessionAuthorized
			? backendMessage("approval.remote_session_unconfined", { command: preview.command })
			: backendMessage("approval.deployment_sandboxed_command", { stage, command: preview.command }) };
}

export const deploymentProposePlanDefinition = {
	name: "deployment_propose_plan",
	label: "Propose deployment plan",
	description: "Submit a deployment plan for server validation and user review. This creates a proposal only. Paths in buildSteps.workdir and artifacts.source are relative to the Session project root. Artifact targets are absolute remote files. Declare known remote write destinations in restart.writePaths and verify.writePaths; when Session sandboxing is enabled, opaque script effects remain confined and a sandbox exception requires separate human approval. When the user disables sandboxing for this Session, remote stages run directly under ordinary approval and Guard.",
	parameters: Type.Object({
		buildSteps: Type.Array(Type.Object({
			workdir: Type.String({ minLength: 1, maxLength: 2_048 }),
			command: Type.String({ minLength: 1, maxLength: 4_000 }),
		}, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
		artifacts: Type.Array(Type.Object({
			source: Type.String({ minLength: 1, maxLength: 2_048 }),
			target: Type.String({ minLength: 1, maxLength: 2_048 }),
		}, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
		restart: commandParameters,
		verify: Type.Optional(commandParameters),
	}, { additionalProperties: false }),
};

export const deploymentInspectDefinition = {
	name: "deployment_inspect",
	label: "Inspect deployment",
	description: "Read the bound deployment plan and current stage results. This tool cannot execute or approve anything.",
	parameters: Type.Object({}, { additionalProperties: false }),
};

export const deploymentExecuteNextDefinition = {
	name: "deployment_execute_next",
	label: "Execute deployment stage",
	description: "Execute exactly one stage from the user-confirmed deployment plan. Supply only the stage name. The server verifies the Agent Run binding, required order, target, Guard, and any sandbox exception approval. A failed stage is not retried automatically.",
	parameters: executeParameters,
};

export const deploymentProposeRecoveryDefinition = {
	name: "deployment_propose_recovery",
	label: "Propose deployment repair",
	description: "After a stage fails, propose a change to that stage only. This never executes or approves a command. Supply the current plan revision from deployment_inspect. Build accepts buildSteps and optional artifacts; upload accepts artifacts; restart/verify accept command and optional declared writePaths. The user reviews the change before the stage can be retried. Build workdirs and artifact sources are relative to the local project root.",
	parameters: Type.Object({
		expectedRevision: Type.Integer({ minimum: 1 }),
		stage: executeParameters.properties.stage,
		reason: Type.String({ minLength: 1, maxLength: 1_000 }),
		buildSteps: Type.Optional(deploymentProposePlanDefinition.parameters.properties.buildSteps),
		artifacts: Type.Optional(deploymentProposePlanDefinition.parameters.properties.artifacts),
		command: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
		writePaths: commandParameters.properties.writePaths,
	}, { additionalProperties: false }),
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
		createRecoveryProposalTool(run, deploymentRunId, deployments),
	];
}

export function createDeploymentRecoveryTools(input: {
	run: { id: string; sessionId: string };
	deploymentRunId: string;
	deployments: AgentDeploymentService;
}): AgentTool[] {
	return [
		{ ...deploymentInspectDefinition, executionMode: "sequential", execute: async () => result(input.deployments.get(input.run.sessionId, input.deploymentRunId), true) },
		createRecoveryProposalTool(input.run, input.deploymentRunId, input.deployments),
	];
}

function createRecoveryProposalTool(run: { id: string; sessionId: string }, deploymentRunId: string,
	deployments: AgentDeploymentService): AgentTool {
	return {
		...deploymentProposeRecoveryDefinition,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const { expectedRevision, ...proposal } = params as DeploymentRecoveryInput & { expectedRevision: number };
			const snapshot = await deployments.proposeRecoveryForAgent(run.sessionId, deploymentRunId, run.id, expectedRevision,
				proposal, signal ?? new AbortController().signal);
			return result(snapshot, false, snapshot.recoveries?.at(-1)?.stage);
		},
	};
}

export function createDeploymentPlanningTool(input: {
	run: { id: string; sessionId: string };
	discussionId: string;
	revision: number;
	deployments: AgentDeploymentService;
}): AgentTool {
	const { run, discussionId, revision, deployments } = input;
	return {
		...deploymentProposePlanDefinition,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const snapshot = await deployments.proposeForDiscussion(
				run.sessionId, discussionId, revision, run.id, params as DeploymentPlanProposal, signal ?? new AbortController().signal,
			);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({
					deploymentRunId: snapshot.id,
					status: snapshot.status,
					plan: { project: snapshot.plan.project, module: snapshot.plan.module, target: snapshot.plan.target },
				}) }],
				details: {},
			};
		},
	};
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
			planRevision: run.planRevision ?? 1,
			...(run.recoveries?.at(-1) ? { recovery: run.recoveries.at(-1) } : {}),
			nextStage,
			...(run.error === undefined ? {} : { error: run.error }),
			...(includePlan ? { plan: run.plan } : {}),
			stages,
		}) }],
		details: {},
	};
}
