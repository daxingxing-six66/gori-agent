import { isAbsolute, posix } from "node:path";
import { deploymentArray, deploymentInputError, deploymentJsonSize, deploymentObject, deploymentText } from "./deployment-validation.ts";

/** Exact per-release inputs proposed by the model, before path resolution and user confirmation. */
export interface DeploymentPlanProposal {
	buildSteps: { workdir: string; command: string }[];
	artifacts: { source: string; target: string }[];
	restart: { command: string; writePaths?: string[] };
	verify?: { command: string; writePaths?: string[] };
}

const CODE = "deployment_proposal_invalid";

/** Enforce the same precise field rules for model calls and direct service callers. */
export function validateDeploymentProposal(value: DeploymentPlanProposal): DeploymentPlanProposal {
	const body = deploymentObject(value, "proposal", ["buildSteps", "artifacts", "restart", "verify"], CODE);
	deploymentJsonSize(body, CODE);
	const buildSteps = deploymentArray(body.buildSteps, "buildSteps", 8, CODE).map((value, index) => {
		const field = `buildSteps[${index}]`;
		const step = deploymentObject(value, field, ["workdir", "command"], CODE);
		return { workdir: relativePath(step.workdir, `${field}.workdir`, true), command: deploymentText(step.command, `${field}.command`, 4_000, CODE) };
	});
	const targets = new Map<string, number>();
	const artifacts = deploymentArray(body.artifacts, "artifacts", 16, CODE).map((value, index) => {
		const field = `artifacts[${index}]`;
		const artifact = deploymentObject(value, field, ["source", "target"], CODE);
		const source = relativePath(artifact.source, `${field}.source`, false);
		const target = remotePath(artifact.target, `${field}.target`, false);
		if (targets.has(target)) deploymentInputError(CODE, `${field}.target`, `duplicates artifacts[${targets.get(target)}].target; each remote target must be unique`);
		targets.set(target, index);
		return { source, target };
	});
	return { buildSteps, artifacts, restart: remoteCommand(body.restart, "restart"),
		...(body.verify === undefined ? {} : { verify: remoteCommand(body.verify, "verify") }) };
}

function remoteCommand(value: unknown, field: string): DeploymentPlanProposal["restart"] {
	const body = deploymentObject(value, field, ["command", "writePaths"], CODE);
	const command = deploymentText(body.command, `${field}.command`, 4_000, CODE);
	if (body.writePaths === undefined) return { command };
	const writePaths = deploymentArray(body.writePaths, `${field}.writePaths`, 16, CODE)
		.map((path, index) => remotePath(path, `${field}.writePaths[${index}]`, true));
	const seen = new Map<string, number>();
	for (const [index, path] of writePaths.entries()) {
		if (seen.has(path)) deploymentInputError(CODE, `${field}.writePaths[${index}]`, `duplicates ${field}.writePaths[${seen.get(path)}]`);
		seen.set(path, index);
	}
	return { command, writePaths };
}

function relativePath(value: unknown, field: string, allowRoot: boolean): string {
	deploymentText(value, field, 2_048, CODE);
	const path = value as string;
	if (isAbsolute(path) || path.includes("\\")) deploymentInputError(CODE, field, "must be a forward-slash path relative to the Session project root; absolute paths are not allowed");
	if (/[\0-\x1f]/u.test(path)) deploymentInputError(CODE, field, "must not contain control characters or newlines");
	if (path.split("/").some((part) => !part || part === "..")) deploymentInputError(CODE, field, "must stay within the project and must not contain '..' or empty path segments");
	if (!allowRoot && path === ".") deploymentInputError(CODE, field, "must identify a file, not the project directory");
	return path;
}

function remotePath(value: unknown, field: string, allowRoot: boolean): string {
	deploymentText(value, field, 2_048, CODE);
	const path = value as string;
	if (!path.startsWith("/")) deploymentInputError(CODE, field, "must be an absolute Linux path beginning with '/'");
	if ((!allowRoot && path === "/") || (path !== "/" && path.endsWith("/"))) deploymentInputError(CODE, field, allowRoot ? "must not end with '/' except for the root directory" : "must identify a file and must not end with '/'");
	if (posix.normalize(path) !== path) deploymentInputError(CODE, field, "must be normalized without '.', '..' or repeated slashes");
	if (/[\0-\x1f]/u.test(path)) deploymentInputError(CODE, field, "must not contain control characters or newlines");
	return path;
}
