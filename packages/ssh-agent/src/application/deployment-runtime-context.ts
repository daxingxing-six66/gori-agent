import type { DeploymentModeView } from "../domain/deployment-session.ts";
import type { RuntimeContextSnapshot } from "../domain/runtime-context.ts";

/** Complete domain facts; the shared journal owns placement and persistence. */
export function deploymentRuntimeSnapshot(mode: DeploymentModeView | null, sessionId: string): RuntimeContextSnapshot {
	if (!mode) return { channel: "deployment", scope: sessionId, active: false, data: {} };
	const actions = mode.phase === "discussion" ? ["deployment_propose_plan", "deployment_finish"]
		: mode.phase === "review" ? ["deployment_inspect", "deployment_finish"]
		: ["deployment_inspect", "deployment_execute_next", "deployment_propose_recovery", "deployment_finish"];
	const guidance = mode.phase === "discussion" ? "Discuss release scope and propose a plan; do not execute stages."
		: mode.phase === "review" ? "The current plan or repair awaits user review. Inspect, discuss or finish; do not execute unconfirmed stages."
		: "Use only the current confirmed plan. Inspect failed stages before retrying; command or artifact changes require a reviewed repair proposal.";
	return { channel: "deployment", scope: mode.deployment.id, active: true,
		data: { deploymentId: mode.deployment.id, phase: mode.phase, stage: mode.stage, stageStatus: mode.stageStatus,
			nextStage: mode.nextStage, selection: mode.selection, planRevision: mode.run?.planRevision ?? null, phaseTools: actions,
			stages: mode.run ? Object.fromEntries(Object.entries(mode.run.stages).map(([name, state]) => [name, state.status])) : {} },
		instructions: `${guidance} Current phase restrictions take precedence over earlier workflow guidance. Phase tools still require this Run's backend binding and approvals. Failed stages or an ended Chat Run do not end deployment mode.` };
}
