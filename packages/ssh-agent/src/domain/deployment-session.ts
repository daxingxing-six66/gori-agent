import type { DeploymentDiscussion, DeploymentRun, DeployStage, DeployStageStatus } from "./deployment.ts";

export type DeploymentOutcome = "success" | "failed" | "cancelled";

/** Session mode and stable history identity. Stage facts remain in deployment_runs. */
export interface DeploymentSession {
	id: string;
	sessionId: string;
	workspaceId: string;
	title: string;
	createdAt: number;
	outcome?: DeploymentOutcome;
	reason?: string;
	finishedAt?: number;
}

export interface DeploymentModeView {
	deployment: DeploymentSession;
	run: DeploymentRun | null;
	selection?: DeploymentSelection;
	phase: "discussion" | "review" | "execution" | "finished";
	stage: DeployStage | null;
	stageStatus: DeployStageStatus | null;
	nextStage: Exclude<DeployStage, "prepare"> | null;
}

/** Discussions require an explicit Profile/module ID request; there is no default-module branch. */
export interface DeploymentSelection {
	source: "user";
	profileFile: string;
	profileHash: string;
	module: { id: string; name: string };
}

export function deploymentSelection(discussion: Pick<DeploymentDiscussion, "profileFile" | "profileHash" | "module">): DeploymentSelection {
	return { source: "user", profileFile: discussion.profileFile, profileHash: discussion.profileHash,
		module: { id: discussion.module.id, name: discussion.module.name } };
}

export function deploymentAwaitsResume(run: DeploymentRun): boolean {
	return run.status === "recovering" && run.recoveries?.at(-1)?.status === "approved" &&
		!["build", "upload", "restart", "verify"].some((stage) => run.stages[stage as keyof DeploymentRun["stages"]].status === "failed");
}

export function deploymentModeView(deployment: DeploymentSession, run: DeploymentRun | null, selection?: DeploymentSelection): DeploymentModeView {
	const stages = ["build", "upload", "restart", "verify"] as const;
	const completed = run ? (["prepare", ...stages] as const).filter((name) => run.stages[name].finishedAt !== undefined)
		.sort((a, b) => (run.stages[a].finishedAt ?? 0) - (run.stages[b].finishedAt ?? 0)).at(-1) : null;
	const stage = run ? stages.find((name) => run.stages[name].status === "running")
		?? stages.find((name) => run.stages[name].status === "failed")
		?? completed ?? stages.find((name) => run.stages[name].status === "pending") ?? "verify" : null;
	return {
		deployment, run,
		...(selection ? { selection } : {}),
		phase: deployment.outcome ? "finished" : !run ? "discussion" : run.status === "preparing" ? "review" : "execution",
		stage, stageStatus: stage && run ? run.stages[stage].status : null,
		nextStage: run ? stages.find((name) => run.stages[name].status === "pending" || run.stages[name].status === "failed") ?? null : null,
	};
}
