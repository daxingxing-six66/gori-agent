import { posix } from "node:path";
import { parseDocument } from "yaml";
import type { SshFailureCode, SshSafeDetail } from "./ssh-failure.ts";

export const DEPLOY_STAGES = ["prepare", "build", "upload", "restart", "verify"] as const;
export type DeployStage = typeof DEPLOY_STAGES[number];
export type DeployStageStatus = "pending" | "running" | "success" | "failed" | "skipped";
export type DeployStatus = "preparing" | "running" | "success" | "failed" | "cancelled";
export type DeploymentFullAccessReason = "sandbox_unavailable" | "sandbox_partial_enforcement";
export type DeploymentRemoteAccess = { mode: "workspace_write" } | { mode: "full_access"; reason: DeploymentFullAccessReason };
export type DeploymentRemoteStage = "restart" | "verify";

export interface DeploymentFullAccessApproval {
	id: string;
	stage: DeploymentRemoteStage;
	command: string;
	status: "pending" | "approved" | "rejected";
	requestedAt: number;
	resolvedAt?: number;
	expiresAt?: number;
}

export interface DeployModule {
	id: string;
	name: string;
	workdir: string;
	build: { command: string; artifact: string };
	upload: { target: string };
	restart: { command: string };
	verify?: { command: string };
}

export interface DeploymentProfile {
	version: 1;
	project: string;
	target: { host: string; name?: string };
	connection: { profile: string };
	modules: DeployModule[];
}

export interface DeploymentPlan {
	profilePath: string;
	profileHash: string;
	remoteAccess: DeploymentRemoteAccess;
	project: string;
	target: { host: string; name?: string };
	targetBinding: { workspaceRevision?: number; port: number; hostKeyAlgorithm?: string; hostKeyFingerprint: string; credentialId: string; credentialAuthVersion: number; remoteUser: string; writableRoot: string };
	module: { id: string; name: string };
	build: { cwd: string; command: string; artifact: string };
	upload: { remotePath: string };
	restart: { command: string };
	verify?: { command: string };
}

export interface DeploymentStageView {
	status: DeployStageStatus;
	startedAt?: number;
	finishedAt?: number;
	log: string;
	progress?: { current: number; total: number };
	error?: string;
	exitCode?: number;
	failureCode?: SshFailureCode;
	safeDetails?: Record<string, SshSafeDetail>;
	operationId?: string;
}

export interface DeploymentRun {
	id: string;
	sessionId: string;
	workspaceId: string;
	/** The Chat Run allowed to advance this deployment after the plan was claimed. */
	agentRunId?: string;
	status: DeployStatus;
	plan: DeploymentPlan;
	stages: Record<DeployStage, DeploymentStageView>;
	fullAccessApprovals?: Partial<Record<DeploymentRemoteStage, DeploymentFullAccessApproval>>;
	createdAt: number;
	/** When the user-confirmed plan was claimed by an Agent Run. */
	startedAt?: number;
	updatedAt: number;
	finishedAt?: number;
	error?: string;
}

export class DeploymentError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "DeploymentError";
		this.code = code;
		this.status = status;
	}
}

/** Parse only the machine-readable front matter. Human notes are never executable. */
export function parseDeploymentProfile(source: string): DeploymentProfile {
	if (Buffer.byteLength(source, "utf8") > 128 * 1024)
		throw new DeploymentError("deployment_profile_invalid", "Deployment profile is too large");
	const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1];
	if (frontMatter === undefined)
		throw new DeploymentError("deployment_profile_invalid", "Deployment profile needs YAML front matter");
	const document = parseDocument(frontMatter, { uniqueKeys: true, strict: true });
	if (document.errors.length > 0)
		throw new DeploymentError("deployment_profile_invalid", `Invalid deployment YAML: ${document.errors[0]?.message}`);
	const root = record(document.toJS({ maxAliasCount: 0 }), "profile");
	keys(root, ["version", "project", "target", "connection", "modules"], "profile");
	if (root.version !== 1) throw new DeploymentError("deployment_profile_invalid", "Unsupported deployment profile version");
	const target = record(root.target, "target");
	keys(target, ["host", "name"], "target");
	const connection = record(root.connection, "connection");
	keys(connection, ["profile"], "connection");
	if (!Array.isArray(root.modules) || root.modules.length === 0 || root.modules.length > 50)
		throw new DeploymentError("deployment_profile_invalid", "modules must contain 1 to 50 entries");
	const ids = new Set<string>();
	const modules = root.modules.map((value, index): DeployModule => {
		const label = `modules[${index}]`;
		const module = record(value, label);
		keys(module, ["id", "name", "workdir", "build", "upload", "restart", "verify"], label);
		const id = field(module.id, `${label}.id`, 80);
		if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id) || ids.has(id))
			throw new DeploymentError("deployment_profile_invalid", `Invalid or duplicate ${label}.id`);
		ids.add(id);
		const build = record(module.build, `${label}.build`);
		keys(build, ["command", "artifact"], `${label}.build`);
		const upload = record(module.upload, `${label}.upload`);
		keys(upload, ["target"], `${label}.upload`);
		const restart = record(module.restart, `${label}.restart`);
		keys(restart, ["command"], `${label}.restart`);
		const verify = module.verify === undefined ? undefined : record(module.verify, `${label}.verify`);
		if (verify) keys(verify, ["command"], `${label}.verify`);
		const remotePath = field(upload.target, `${label}.upload.target`, 2048);
		if (!remotePath.startsWith("/") || remotePath === "/" || remotePath.endsWith("/") || posix.normalize(remotePath) !== remotePath)
			throw new DeploymentError("deployment_profile_invalid", `${label}.upload.target must be a normalized absolute file path`);
		return {
			id,
			name: field(module.name, `${label}.name`, 200),
			workdir: relativePath(module.workdir, `${label}.workdir`),
			build: { command: field(build.command, `${label}.build.command`, 4000), artifact: relativePath(build.artifact, `${label}.build.artifact`) },
			upload: { target: remotePath },
			restart: { command: field(restart.command, `${label}.restart.command`, 4000) },
			...(verify === undefined ? {} : { verify: { command: field(verify.command, `${label}.verify.command`, 4000) } }),
		};
	});
	return {
		version: 1,
		project: field(root.project, "project", 200),
		target: { host: field(target.host, "target.host", 255), ...(target.name === undefined ? {} : { name: field(target.name, "target.name", 200) }) },
		connection: { profile: field(connection.profile, "connection.profile", 200) },
		modules,
	};
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DeploymentError("deployment_profile_invalid", `${name} must be an object`);
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const extra = Object.keys(value).find((key) => !allowed.includes(key));
	if (extra) throw new DeploymentError("deployment_profile_invalid", `${name}.${extra} is not supported`);
}

function field(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0-\x08\x0b\x0c\x0e-\x1f]/u.test(value))
		throw new DeploymentError("deployment_profile_invalid", `${name} must be non-empty text`);
	return value.trim();
}

function relativePath(value: unknown, name: string): string {
	const path = field(value, name, 2048);
	const parts = path.split(/[\\/]/u);
	if (path.startsWith("/") || parts.includes("..") || parts.includes("") || path.includes("\\"))
		throw new DeploymentError("deployment_profile_invalid", `${name} must stay within the project`);
	return path;
}
