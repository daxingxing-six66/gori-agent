import { DEPLOY_STAGES, isDeploymentRun, type DeploymentRun, type DeployStage, type DeploymentExecutableStage } from "./deployment";

export interface DeploymentTask {
	deployment: { id: string; sessionId: string; workspaceId: string; title: string; createdAt: number;
		outcome?: "success" | "failed" | "cancelled"; reason?: string; finishedAt?: number };
	run: DeploymentRun | null;
	phase: "discussion" | "review" | "execution" | "finished";
	stage: DeployStage | null;
	stageStatus: DeploymentRun["stages"][DeployStage]["status"] | null;
	nextStage: DeploymentExecutableStage | null;
}

export interface DeploymentLogChunk {
	deploymentRunId: string; executionId: string; stage: DeploymentExecutableStage; sequence: number;
	timestamp: number; kind: "boundary" | "output" | "result"; text: string;
}
export interface DeploymentLogPage { chunks: DeploymentLogChunk[]; nextSequence: number; hasMore: boolean }

export function isDeploymentTask(value: unknown): value is DeploymentTask {
	if (!record(value) || !record(value.deployment)) return false;
	const task = value.deployment;
	return [task.id, task.sessionId, task.workspaceId, task.title].every(text) && time(task.createdAt) &&
		(task.outcome === undefined || ["success", "failed", "cancelled"].includes(String(task.outcome))) &&
		(task.reason === undefined || text(task.reason)) &&
		(task.outcome === undefined ? task.finishedAt === undefined : time(task.finishedAt) && task.finishedAt >= task.createdAt) &&
		(value.run === null || isDeploymentRun(value.run) && value.run.id === task.id && value.run.sessionId === task.sessionId && value.run.workspaceId === task.workspaceId) &&
		["discussion", "review", "execution", "finished"].includes(String(value.phase)) &&
		(value.phase === "finished") === (task.outcome !== undefined) &&
		(value.stage === null || DEPLOY_STAGES.includes(value.stage as DeployStage)) &&
		(value.stageStatus === null || ["pending", "running", "success", "failed", "skipped"].includes(String(value.stageStatus))) &&
		(value.nextStage === null || ["build", "upload", "restart", "verify"].includes(String(value.nextStage)));
}

export function isDeploymentLogChunk(value: unknown): value is DeploymentLogChunk {
	return record(value) && text(value.deploymentRunId) && text(value.executionId) &&
		["build", "upload", "restart", "verify"].includes(String(value.stage)) &&
		Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0 && time(value.timestamp) &&
		["boundary", "output", "result"].includes(String(value.kind)) && typeof value.text === "string";
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function time(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
