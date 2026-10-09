import { relative } from "node:path";
import { DeploymentError, type DeploymentExecutableStage, type DeploymentPlanV2 } from "../domain/deployment.ts";
import { validateDeploymentProposal, type DeploymentPlanProposal } from "./deployment-plan-proposal.ts";

/** Model input changes one failed stage. It is converted to a complete proposal for the existing path validators. */
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
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).some((key) => !["stage", "reason", "buildSteps", "artifacts", "command", "writePaths"].includes(key))) throw invalid();
	let serialized: string;
	try { serialized = JSON.stringify(value); } catch { throw invalid(); }
	if (Buffer.byteLength(serialized, "utf8") > 96 * 1024 ||
		!["build", "upload", "restart", "verify"].includes(value.stage) ||
		typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 1_000 ||
		/[\0-\x1f]/u.test(value.reason)) throw invalid();
	if (value.stage === "build" ? !value.buildSteps || value.command !== undefined || value.writePaths !== undefined
		: value.stage === "upload" ? !value.artifacts || value.buildSteps !== undefined || value.command !== undefined || value.writePaths !== undefined
		: value.command === undefined || value.buildSteps !== undefined || value.artifacts !== undefined) throw invalid();
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

function invalid(): DeploymentError {
	return new DeploymentError("deployment_recovery_invalid", "Recovery proposal must change only the failed stage", 400);
}
