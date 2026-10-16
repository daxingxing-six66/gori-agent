import type { DeploymentExecutableStage } from "../../domain/deployment.ts";
import type { DeploymentLogChunk, DeploymentLogPage, DeploymentStageExecution } from "../../domain/deployment-execution.ts";

export interface DeploymentExecutionRepository {
	findRequest(deploymentRunId: string, requestId: string): DeploymentStageExecution | undefined;
	insert(execution: DeploymentStageExecution): void;
	finish(execution: DeploymentStageExecution): void;
	append(chunk: Omit<DeploymentLogChunk, "sequence">): DeploymentLogChunk;
	logs(deploymentRunId: string, stage: DeploymentExecutableStage, afterSequence: number, limit: number): DeploymentLogPage;
	recoverInterrupted(now: number): void;
}
