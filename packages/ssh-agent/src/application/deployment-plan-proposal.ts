import { isAbsolute, posix } from "node:path";
import { DeploymentError } from "../domain/deployment.ts";

/** Exact per-release inputs proposed by the model, before path resolution and user confirmation. */
export interface DeploymentPlanProposal {
	buildSteps: { workdir: string; command: string }[];
	artifacts: { source: string; target: string }[];
	restart: { command: string; writePaths?: string[] };
	verify?: { command: string; writePaths?: string[] };
}

/** Treat model Tool arguments as untrusted even when the Tool schema was checked upstream. */
export function validateDeploymentProposal(value: DeploymentPlanProposal): DeploymentPlanProposal {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProposal();
	proposalKeys(value, ["buildSteps", "artifacts", "restart", "verify"]);
	let serialized: string;
	try { serialized = JSON.stringify(value); } catch { throw invalidProposal(); }
	if (Buffer.byteLength(serialized, "utf8") > 96 * 1024) throw invalidProposal();
	if (!Array.isArray(value.buildSteps) || value.buildSteps.length < 1 || value.buildSteps.length > 8 ||
		!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 16) throw invalidProposal();
	const buildSteps = value.buildSteps.map((step) => {
		proposalKeys(step, ["workdir", "command"]);
		return { workdir: proposalRelativePath(step.workdir, true), command: proposalCommand(step.command) };
	});
	const targets = new Set<string>();
	const artifacts = value.artifacts.map((artifact) => {
		proposalKeys(artifact, ["source", "target"]);
		const source = proposalRelativePath(artifact.source, false);
		const target = proposalRemotePath(artifact.target);
		if (targets.has(target)) throw new DeploymentError("deployment_proposal_invalid", "Duplicate deployment target", 400);
		targets.add(target);
		return { source, target };
	});
	proposalKeys(value.restart, ["command", "writePaths"]);
	if (value.verify !== undefined) proposalKeys(value.verify, ["command", "writePaths"]);
	return {
		buildSteps, artifacts,
		restart: proposalRemoteCommand(value.restart),
		...(value.verify === undefined ? {} : { verify: proposalRemoteCommand(value.verify) }),
	};
}

function proposalRemoteCommand(value: DeploymentPlanProposal["restart"]): DeploymentPlanProposal["restart"] {
	const command = proposalCommand(value?.command);
	if (value.writePaths === undefined) return { command };
	if (!Array.isArray(value.writePaths) || value.writePaths.length < 1 || value.writePaths.length > 16) throw invalidProposal();
	const writePaths = value.writePaths.map(proposalRemoteWritePath);
	if (new Set(writePaths).size !== writePaths.length) throw invalidProposal();
	return { command, writePaths };
}

function proposalKeys(value: unknown, allowed: readonly string[]): void {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw invalidProposal();
}

function proposalCommand(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4_000 || /[\0-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw invalidProposal();
	return value.trim();
}

function proposalRelativePath(value: unknown, allowRoot: boolean): string {
	if (typeof value !== "string" || !value || value.length > 2_048 || isAbsolute(value) || value.includes("\\") || /[\0-\x1f]/u.test(value) ||
		value.split("/").some((part) => !part || part === "..") || (!allowRoot && value === ".")) throw invalidProposal();
	return value;
}

function proposalRemotePath(value: unknown): string {
	if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("/") || value === "/" ||
		value.endsWith("/") || posix.normalize(value) !== value || /[\0-\x1f]/u.test(value)) throw invalidProposal();
	return value;
}

function proposalRemoteWritePath(value: unknown): string {
	if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("/") ||
		(value !== "/" && value.endsWith("/")) || posix.normalize(value) !== value || /[\0-\x1f]/u.test(value)) throw invalidProposal();
	return value;
}

function invalidProposal(): DeploymentError {
	return new DeploymentError("deployment_proposal_invalid", "Deployment proposal has invalid commands or paths", 400);
}
