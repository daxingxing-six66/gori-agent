import { DEPLOY_STAGES, deploymentRemoteStageAccess, type DeploymentRemoteStage, type DeploymentRun } from "./deployment";

export interface DeploymentReviewState {
	initialPlan: boolean;
	resume: boolean;
	showRecovery: boolean;
	exceptionStages: DeploymentRemoteStage[];
	pendingExceptions: DeploymentRemoteStage[];
}

/** Preparing/abandoned plans are not execution progress. Older runs may omit startedAt. */
export function deploymentHasExecution(run: DeploymentRun): boolean {
	return run.status !== "preparing" && (run.startedAt !== undefined || run.status === "running" || run.status === "recovering" ||
		DEPLOY_STAGES.slice(1).some((stage) => run.stages[stage].status !== "pending"));
}

export function deploymentAwaitsResume(run: DeploymentRun): boolean {
	return run.status === "recovering" && run.recoveries?.at(-1)?.status === "approved" &&
		!DEPLOY_STAGES.some((stage) => run.stages[stage].status === "failed");
}

/** A failed stage is model context. Only actual plan/permission decisions need UI. */
export function deploymentReviewState(run: DeploymentRun, now = Date.now()): DeploymentReviewState | null {
	if (run.status !== "preparing" && run.status !== "recovering") return null;
	const exceptionStages = (["restart", "verify"] as const).filter((stage) => {
		const access = deploymentRemoteStageAccess(run.plan, stage);
		return run.plan[stage] && access.mode === "full_access" && access.reason !== "session_sandbox_disabled";
	});
	const pendingExceptions = exceptionStages.filter((stage) => {
		const approval = run.fullAccessApprovals?.[stage];
		return !["success", "skipped"].includes(run.stages[stage].status) &&
			(approval?.status !== "approved" || (approval.expiresAt ?? 0) <= now);
	});
	const initialPlan = run.status === "preparing";
	const resume = deploymentAwaitsResume(run);
	const pendingRecovery = run.recoveries?.at(-1)?.status === "pending";
	if (!initialPlan && !resume && !pendingRecovery && pendingExceptions.length === 0) return null;
	return { initialPlan, resume, showRecovery: !initialPlan && (pendingRecovery || resume), exceptionStages,
		pendingExceptions: pendingRecovery ? [] : pendingExceptions };
}

export function deploymentNeedsReview(run: DeploymentRun, now = Date.now()): boolean {
	return deploymentReviewState(run, now) !== null;
}
