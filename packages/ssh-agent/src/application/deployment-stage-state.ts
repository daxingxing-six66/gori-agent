import { DeploymentError, type DeploymentExecutableStage, type DeploymentRun } from "../domain/deployment.ts";

export const EXECUTABLE_DEPLOYMENT_STAGES = ["build", "upload", "restart", "verify"] as const;

export function assertDeploymentStageOrder(run: DeploymentRun, stage: DeploymentExecutableStage): void {
	const position = EXECUTABLE_DEPLOYMENT_STAGES.indexOf(stage);
	if (position < 0) throw new DeploymentError("deployment_stage_invalid", `stage: ${String(stage)} is invalid; expected build, upload, restart or verify`, 400, { field: "stage" });
	if (EXECUTABLE_DEPLOYMENT_STAGES.slice(0, position).some((name) => !["success", "skipped"].includes(run.stages[name].status))) {
		const next = EXECUTABLE_DEPLOYMENT_STAGES.find((name) => !["success", "skipped"].includes(run.stages[name].status));
		throw new DeploymentError("deployment_stage_out_of_order", `stage: cannot execute ${stage}; complete ${next} first (current status: ${next ? run.stages[next].status : "unknown"})`, 409, { field: "stage", details: { requestedStage: stage, nextStage: next ?? "none" } });
	}
}

/** Invalidate current results, retaining each stage's complete append-only history. */
export function invalidateDeploymentStages(run: DeploymentRun, from: DeploymentExecutableStage): void {
	for (const stage of EXECUTABLE_DEPLOYMENT_STAGES.slice(EXECUTABLE_DEPLOYMENT_STAGES.indexOf(from))) {
		const previous = run.stages[stage];
		run.stages[stage] = { status: "pending", log: previous.log,
			...(previous.logCursor === undefined ? {} : { logCursor: previous.logCursor }),
			...(previous.logTruncated ? { logTruncated: true } : {}) };
	}
	delete run.error;
	delete run.finishedAt;
}
