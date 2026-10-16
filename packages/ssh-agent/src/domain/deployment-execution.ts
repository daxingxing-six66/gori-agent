import type { DeploymentExecutableStage, DeploymentStageView } from "./deployment.ts";

export interface DeploymentStageExecution {
	id: string;
	deploymentRunId: string;
	requestId: string;
	agentRunId: string;
	stage: DeploymentExecutableStage;
	planRevision: number;
	status: "running" | "success" | "failed" | "skipped" | "interrupted";
	startedAt: number;
	finishedAt?: number;
	result?: DeploymentStageView;
}

export interface DeploymentLogChunk {
	deploymentRunId: string;
	executionId: string;
	stage: DeploymentExecutableStage;
	sequence: number;
	timestamp: number;
	kind: "boundary" | "output" | "result";
	text: string;
}

export interface DeploymentLogPage {
	chunks: DeploymentLogChunk[];
	nextSequence: number;
	hasMore: boolean;
}
