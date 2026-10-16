import { posix } from "node:path";
import { parseDocument } from "yaml";
import type { SshFailureCode, SshSafeDetail } from "./ssh-failure.ts";

export const DEPLOY_STAGES = ["prepare", "build", "upload", "restart", "verify"] as const;
export type DeployStage = typeof DEPLOY_STAGES[number];
export type DeployStageStatus = "pending" | "running" | "success" | "failed" | "skipped";
export type DeployStatus = "preparing" | "running" | "recovering" | "success" | "failed" | "cancelled";
export type DeploymentFullAccessReason = "deployment_policy" | "sandbox_unavailable" | "sandbox_partial_enforcement" | "sandbox_scope_exceeded" | "session_sandbox_disabled";
export type DeploymentRemoteAccess = { mode: "workspace_write" } | { mode: "full_access"; reason: DeploymentFullAccessReason };
export type DeploymentRemoteStage = "restart" | "verify";

export interface DeploymentRemoteCommand {
	command: string;
	/** Declared destinations; an opaque script may still write elsewhere and remains sandboxed at execution. */
	writePaths?: string[];
	/** New plans bind each command separately. Historical plans fall back to plan.remoteAccess. */
	access?: DeploymentRemoteAccess;
}

export interface DeploymentFullAccessApproval {
	id: string;
	stage: DeploymentRemoteStage;
	command: string;
	status: "pending" | "approved" | "rejected";
	requestedAt: number;
	resolvedAt?: number;
	expiresAt?: number;
	/** Identifies why this exceptional approval exists, including in deployment API snapshots. */
	toolName?: "remote_sandbox_exception";
	reason?: Exclude<DeploymentFullAccessReason, "session_sandbox_disabled">;
}

export interface DeployModuleV1 {
	id: string;
	name: string;
	workdir: string;
	build: { command: string; artifact: string };
	upload: { target: string };
	restart: { command: string };
	verify?: { command: string };
}

export interface DeployModuleV2 {
	id: string;
	name: string;
	workdir: string;
	build: { instructions: string };
	upload: { allowedDirectories: string[] };
	restart: { instructions: string };
	verify?: { instructions: string };
}

interface DeploymentProfileBase {
	project: string;
	target: { host: string; name?: string };
	connection: { profile: string };
}

export interface DeploymentProfileV1 extends DeploymentProfileBase {
	version: 1;
	modules: DeployModuleV1[];
}

export interface DeploymentProfileV2 extends DeploymentProfileBase {
	version: 2;
	modules: DeployModuleV2[];
}

export type DeploymentProfile = DeploymentProfileV1 | DeploymentProfileV2;

interface DeploymentPlanBase {
	profilePath: string;
	profileHash: string;
	remoteAccess: DeploymentRemoteAccess;
	project: string;
	target: { host: string; name?: string };
	targetBinding: { workspaceRevision?: number; port: number; hostKeyAlgorithm?: string; hostKeyFingerprint: string; credentialId: string; credentialAuthVersion: number; remoteUser: string; /** Legacy audit metadata only; never used as an upload or sandbox boundary. */ writableRoot?: string; sandboxWritableRoots?: string[] };
	module: { id: string; name: string };
	restart: DeploymentRemoteCommand;
	verify?: DeploymentRemoteCommand;
}

/** Historical plans have no version field and contain one build and upload. */
export interface DeploymentPlanV1 extends DeploymentPlanBase {
	version?: undefined;
	build: { cwd: string; command: string; artifact: string };
	upload: { remotePath: string };
}

export interface DeploymentPlanV2 extends DeploymentPlanBase {
	version: 2;
	buildSteps: { cwd: string; command: string }[];
	artifacts: { source: string; remotePath: string }[];
}

export type DeploymentPlan = DeploymentPlanV1 | DeploymentPlanV2;

export interface DeploymentStageView {
	status: DeployStageStatus;
	executionId?: string;
	/** Last durable chunk in deployment_logs; log is a bounded display/model tail. */
	logCursor?: number;
	logTruncated?: boolean;
	startedAt?: number;
	finishedAt?: number;
	log: string;
	progress?: { current: number; total: number };
	step?: { current: number; total: number; cwd: string; command: string };
	artifact?: { index: number; count: number; source: string; remotePath: string; bytesTransferred: number; totalBytes: number };
	error?: string;
	exitCode?: number;
	failureCode?: SshFailureCode;
	safeDetails?: Record<string, SshSafeDetail>;
	operationId?: string;
}

export type DeploymentExecutableStage = Exclude<DeployStage, "prepare">;

export interface DeploymentStageAttempt {
	planRevision: number;
	agentRunId: string;
	result: DeploymentStageView;
}

export interface DeploymentRecoveryProposal {
	id: string;
	stage: DeploymentExecutableStage;
	reason: string;
	plan: DeploymentPlanV2;
	baseRevision: number;
	status: "pending" | "approved" | "rejected";
	agentRunId: string;
	proposedAt: number;
	resolvedAt?: number;
}

export interface DeploymentRun {
	id: string;
	sessionId: string;
	workspaceId: string;
	/** The durable discussion that led to this plan, when one exists. */
	discussionId?: string;
	/** The Chat Run allowed to advance this deployment after the plan was claimed. */
	agentRunId?: string;
	/** All execution and recovery Chat Runs associated with this deployment card. */
	agentRunHistory?: string[];
	/** The Chat Run that proposed this exact plan before user confirmation. */
	planningAgentRunId?: string;
	/** Stable digest of the model's structured proposal for idempotent retries. */
	planningProposalHash?: string;
	status: DeployStatus;
	plan: DeploymentPlan;
	/** Revision 1 is the original user-confirmed plan. Older snapshots omit it. */
	planRevision?: number;
	initialPlan?: DeploymentPlanV2;
	stageAttempts?: Partial<Record<DeploymentExecutableStage, DeploymentStageAttempt[]>>;
	recoveries?: DeploymentRecoveryProposal[];
	stages: Record<DeployStage, DeploymentStageView>;
	fullAccessApprovals?: Partial<Record<DeploymentRemoteStage, DeploymentFullAccessApproval>>;
	createdAt: number;
	/** When the user-confirmed plan was claimed by an Agent Run. */
	startedAt?: number;
	updatedAt: number;
	finishedAt?: number;
	error?: string;
}

export type DeploymentDiscussionStatus = "discussing" | "proposed" | "cancelled";

/** Durable task context across multiple Chat Runs. No deployment stages exist yet. */
export interface DeploymentDiscussion {
	id: string;
	sessionId: string;
	workspaceId: string;
	status: DeploymentDiscussionStatus;
	revision: number;
	profileFile: string;
	profileHash: string;
	projectRoot: string;
	project: string;
	module: { id: string; name: string };
	targetBinding: {
		hostname: string;
		port: number;
		workspaceRevision: number;
		hostKeyAlgorithm: string;
		hostKeyFingerprint: string;
		credentialId: string;
		credentialAuthVersion: number;
		remoteUser: string;
		/** Legacy audit metadata only; new discussions omit this field. */
		writableRoot?: string;
		sandboxWritableRoots?: string[];
	};
	createdAt: number;
	updatedAt: number;
	deploymentRunId?: string;
}

export class DeploymentError extends Error {
	readonly code: string;
	readonly status: number;
	readonly field?: string;
	readonly details?: Record<string, string | number | boolean | readonly string[]>;
	constructor(code: string, message: string, status = 400, context: {
		field?: string; details?: Record<string, string | number | boolean | readonly string[]>;
	} = {}) {
		super(message);
		this.name = "DeploymentError";
		this.code = code;
		this.status = status;
		this.field = context.field;
		this.details = context.details;
	}

	toJSON() {
		return { code: this.code, message: this.message,
			...(this.field === undefined ? {} : { field: this.field }),
			...(this.details === undefined ? {} : { details: this.details }) };
	}
}

/** Parse only the machine-readable front matter. Human notes are never executable. */
export function parseDeploymentProfile(source: string): DeploymentProfile {
	if (Buffer.byteLength(source, "utf8") > 128 * 1024)
		profileError("file", "must be at most 128 KiB");
	const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1];
	if (frontMatter === undefined)
		profileError("file", "needs YAML front matter between --- delimiters");
	const document = parseDocument(frontMatter, { uniqueKeys: true, strict: true });
	if (document.errors.length > 0)
		profileError("file", `invalid deployment YAML: ${document.errors[0]?.message}`);
	const root = record(document.toJS({ maxAliasCount: 0 }), "profile");
	keys(root, ["version", "project", "target", "connection", "modules"], "profile");
	if (root.version !== 1 && root.version !== 2) profileError("version", "must be 1 or 2");
	const target = record(root.target, "target");
	keys(target, ["host", "name"], "target");
	const connection = record(root.connection, "connection");
	keys(connection, ["profile"], "connection");
	if (!Array.isArray(root.modules) || root.modules.length === 0 || root.modules.length > 50)
		profileError("modules", "must be an array containing 1 to 50 entries");
	const ids = new Set<string>();
	const modules = root.modules.map((value, index): DeployModuleV1 | DeployModuleV2 => {
		const label = `modules[${index}]`;
		const module = record(value, label);
		keys(module, ["id", "name", "workdir", "build", "upload", "restart", "verify"], label);
		const id = field(module.id, `${label}.id`, 80);
		if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id)) profileError(`${label}.id`, "must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores or hyphens");
		if (ids.has(id)) profileError(`${label}.id`, `duplicates an earlier module id: ${id}`);
		ids.add(id);
		const build = record(module.build, `${label}.build`);
		const upload = record(module.upload, `${label}.upload`);
		const restart = record(module.restart, `${label}.restart`);
		const verify = module.verify === undefined ? undefined : record(module.verify, `${label}.verify`);
		const common = {
			id,
			name: field(module.name, `${label}.name`, 200),
			workdir: relativePath(module.workdir, `${label}.workdir`),
		};
		if (root.version === 2) {
			keys(build, ["instructions"], `${label}.build`);
			keys(upload, ["allowedDirectories"], `${label}.upload`);
			keys(restart, ["instructions"], `${label}.restart`);
			if (verify) keys(verify, ["instructions"], `${label}.verify`);
			const directories = upload.allowedDirectories;
			if (!Array.isArray(directories) || directories.length === 0 || directories.length > 16)
				profileError(`${label}.upload.allowedDirectories`, "must be an array containing 1 to 16 directories");
			const allowedDirectories = directories.map((directory, directoryIndex) => absoluteRemotePath(directory, `${label}.upload.allowedDirectories[${directoryIndex}]`, true));
			if (new Set(allowedDirectories).size !== allowedDirectories.length)
				profileError(`${label}.upload.allowedDirectories`, "contains duplicates; each directory must be unique");
			return {
				...common,
				build: { instructions: field(build.instructions, `${label}.build.instructions`, 4000) },
				upload: { allowedDirectories },
				restart: { instructions: field(restart.instructions, `${label}.restart.instructions`, 4000) },
				...(verify === undefined ? {} : { verify: { instructions: field(verify.instructions, `${label}.verify.instructions`, 4000) } }),
			};
		}
		keys(build, ["command", "artifact"], `${label}.build`);
		keys(upload, ["target"], `${label}.upload`);
		keys(restart, ["command"], `${label}.restart`);
		if (verify) keys(verify, ["command"], `${label}.verify`);
		return {
			...common,
			build: { command: field(build.command, `${label}.build.command`, 4000), artifact: relativePath(build.artifact, `${label}.build.artifact`) },
			upload: { target: absoluteRemotePath(upload.target, `${label}.upload.target`, false) },
			restart: { command: field(restart.command, `${label}.restart.command`, 4000) },
			...(verify === undefined ? {} : { verify: { command: field(verify.command, `${label}.verify.command`, 4000) } }),
		};
	});
	const common = {
		project: field(root.project, "project", 200),
		target: { host: field(target.host, "target.host", 255), ...(target.name === undefined ? {} : { name: field(target.name, "target.name", 200) }) },
		connection: { profile: field(connection.profile, "connection.profile", 200) },
	};
	return root.version === 2
		? { ...common, version: 2, modules: modules as DeployModuleV2[] }
		: { ...common, version: 1, modules: modules as DeployModuleV1[] };
}

function absoluteRemotePath(value: unknown, name: string, directory: boolean): string {
	const path = field(value, name, 2048);
	if (!path.startsWith("/") || (!directory && path === "/") ||
		(path !== "/" && path.endsWith("/")) || posix.normalize(path) !== path)
		profileError(name, `must be a normalized absolute ${directory ? "directory" : "file"} path without dot segments, repeated slashes or a trailing slash`);
	return path;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		profileError(name, "must be an object");
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const extra = Object.keys(value).find((key) => !allowed.includes(key));
	if (extra) profileError(`${name}.${extra}`, `is not supported; allowed fields: ${allowed.join(", ")}`);
}

function field(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string") profileError(name, "must be text");
	if (!value.trim()) profileError(name, "must be non-empty text");
	if (value.length > maximum) profileError(name, `must be at most ${maximum} characters; received ${value.length}`);
	if (/[\0-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) profileError(name, "must not contain control characters");
	return value.trim();
}

function relativePath(value: unknown, name: string): string {
	const path = field(value, name, 2048);
	const parts = path.split(/[\\/]/u);
	if (path.startsWith("/") || parts.includes("..") || parts.includes("") || path.includes("\\"))
		profileError(name, "must stay within the project and be relative without backslashes, empty segments or parent traversal");
	return path;
}

function profileError(field: string, reason: string): never {
	throw new DeploymentError("deployment_profile_invalid", `${field}: ${reason}`, 400, { field });
}
