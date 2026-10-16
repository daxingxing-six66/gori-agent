import { relative } from "node:path";
import { type DeploymentExecutableStage, type DeploymentPlanV2 } from "../domain/deployment.ts";
import { validateDeploymentProposal, type DeploymentPlanProposal } from "./deployment-plan-proposal.ts";
import { deploymentInputError, deploymentJsonSize, deploymentObject, deploymentText } from "./deployment-validation.ts";

/** Model input changes one stage. It is converted to a complete proposal for the existing path validators. */
export interface DeploymentRecoveryInput {
	stage: DeploymentExecutableStage;
	reason: string;
	buildSteps?: DeploymentPlanProposal["buildSteps"];
	artifacts?: DeploymentPlanProposal["artifacts"];
	command?: string;
	writePaths?: string[];
}

export function validateRecoveryInput(value: DeploymentRecoveryInput, plan: DeploymentPlanV2, root: string): {
	stage: DeploymentExecutableStage;
	reason: string;
	proposal: DeploymentPlanProposal;
} {
	const code = "deployment_recovery_invalid";
	deploymentObject(value, "proposal", ["stage", "reason", "buildSteps", "artifacts", "command", "writePaths"], code);
	deploymentJsonSize(value, code);
	if (!["build", "upload", "restart", "verify"].includes(value.stage))
		deploymentInputError(code, "stage", "must be build, upload, restart or verify");
	deploymentText(value.reason, "reason", 1_000, code);
	if (/[\0-\x1f]/u.test(value.reason)) deploymentInputError(code, "reason", "must be a single line without control characters");
	const allowed = value.stage === "build" ? ["buildSteps", "artifacts"] : value.stage === "upload" ? ["artifacts"] : ["command", "writePaths"];
	const required = value.stage === "build" ? "buildSteps" : value.stage === "upload" ? "artifacts" : "command";
	if (value[required] === undefined) deploymentInputError(code, required, `is required when repairing ${value.stage}`);
	for (const field of ["buildSteps", "artifacts", "command", "writePaths"] as const)
		if (value[field] !== undefined && !allowed.includes(field))
			deploymentInputError(code, field, `is not allowed when repairing ${value.stage}; allowed changes: ${allowed.join(", ")}`);
	const proposal = validateDeploymentProposal({
		buildSteps: value.stage === "build" ? value.buildSteps! : plan.buildSteps.map((step) => ({
			workdir: relative(root, step.cwd) || ".", command: step.command,
		})),
		artifacts: value.artifacts ?? plan.artifacts.map((artifact) => ({
			source: relative(root, artifact.source), target: artifact.remotePath,
		})),
		restart: value.stage === "restart" ? { command: value.command!, ...(value.writePaths === undefined ? {} : { writePaths: value.writePaths }) }
			: { command: plan.restart.command, ...(plan.restart.writePaths === undefined ? {} : { writePaths: plan.restart.writePaths }) },
		...(plan.verify || value.stage === "verify" ? { verify: {
			command: value.stage === "verify" ? value.command! : plan.verify!.command,
			...((value.stage === "verify" ? value.writePaths : plan.verify?.writePaths) === undefined ? {}
				: { writePaths: value.stage === "verify" ? value.writePaths : plan.verify?.writePaths }),
		} } : {}),
	});
	return { stage: value.stage, reason: value.reason.trim(), proposal };
}
