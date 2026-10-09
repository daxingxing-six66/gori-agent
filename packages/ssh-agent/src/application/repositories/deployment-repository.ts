import type { DeploymentRun } from "../../domain/deployment.ts";

export interface DeploymentHistoryPosition { effectiveAt: number; id: string }

export interface DeploymentRepository {
	insert(run: DeploymentRun): void;
	update(run: DeploymentRun): void;
	approvePreparing(run: DeploymentRun, expectedUpdatedAt: number): boolean;
	updateRecovering(run: DeploymentRun, expectedUpdatedAt: number): boolean;
	claim(run: DeploymentRun): boolean;
	claimRecovering(run: DeploymentRun, expectedUpdatedAt: number): boolean;
	cancelPreparing(run: DeploymentRun): boolean;
	cancelRecovering(run: DeploymentRun, expectedUpdatedAt: number): boolean;
	find(sessionId: string, id: string): DeploymentRun | undefined;
	findByPlanningAgentRunId(sessionId: string, agentRunId: string): DeploymentRun | undefined;
	latest(sessionId: string): DeploymentRun | undefined;
	listRecent(sessionId: string, limit: number, before?: DeploymentHistoryPosition): DeploymentRun[];
	recoverInterrupted(now: number): void;
}
