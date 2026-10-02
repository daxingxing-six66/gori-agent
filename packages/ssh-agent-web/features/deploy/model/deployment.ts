export const DEPLOY_STAGES = ["prepare", "build", "upload", "restart", "verify"] as const;
export type DeployStage = typeof DEPLOY_STAGES[number];
export type DeployStatus = "preparing" | "running" | "success" | "failed" | "cancelled";
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

export interface DeploymentProfileSummary {
	file: string;
	project: string;
	target: { host: string; name?: string };
	modules: { id: string; name: string }[];
}

export interface DeploymentRun {
	id: string;
	sessionId: string;
	workspaceId: string;
	createdAt: number;
	startedAt?: number;
	updatedAt: number;
	agentRunId?: string;
	finishedAt?: number;
	status: DeployStatus;
	plan: {
		profilePath: string;
		profileHash: string;
		remoteAccess: { mode: "workspace_write" } | { mode: "full_access"; reason: "sandbox_unavailable" | "sandbox_partial_enforcement" };
		project: string;
		target: { host: string; name?: string };
		targetBinding: { workspaceRevision?: number; port: number; hostKeyAlgorithm?: string; hostKeyFingerprint: string; credentialId: string; credentialAuthVersion: number; remoteUser: string; writableRoot: string };
		module: { id: string; name: string };
		build: { cwd: string; command: string; artifact: string };
		upload: { remotePath: string };
		restart: { command: string };
		verify?: { command: string };
	};
	stages: Record<DeployStage, {
		status: "pending" | "running" | "success" | "failed" | "skipped";
		log: string;
		startedAt?: number;
		finishedAt?: number;
		progress?: { current: number; total: number };
		error?: string;
		exitCode?: number;
		failureCode?: string;
		operationId?: string;
		safeDetails?: Record<string, string | number | boolean>;
	}>;
	fullAccessApprovals?: Partial<Record<DeploymentRemoteStage, DeploymentFullAccessApproval>>;
	error?: string;
}

export interface DeploymentDiscovery {
	host: string;
	profiles: DeploymentProfileSummary[];
	errors: { file: string; message: string }[];
	latest: DeploymentRun | null;
}

const DEPLOY_STATUSES: readonly DeployStatus[] = ["preparing", "running", "success", "failed", "cancelled"];
const STAGE_STATUSES: readonly DeploymentRun["stages"][DeployStage]["status"][] = ["pending", "running", "success", "failed", "skipped"];

export function isDeploymentRun(value: unknown): value is DeploymentRun {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionId !== "string" ||
		typeof value.workspaceId !== "string" || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) ||
		value.updatedAt < value.createdAt || !oneOf(value.status, DEPLOY_STATUSES) ||
		(value.startedAt !== undefined && (!validTimestamp(value.startedAt) || value.startedAt < value.createdAt || value.startedAt > value.updatedAt)) ||
		(value.finishedAt !== undefined && (!validTimestamp(value.finishedAt) || value.finishedAt < value.createdAt)) ||
		(value.agentRunId !== undefined && (typeof value.agentRunId !== "string" || !value.agentRunId)) ||
		(value.error !== undefined && typeof value.error !== "string") || !isPlan(value.plan) || !isStages(value.stages)) return false;
	if ((value.agentRunId === undefined) !== (value.startedAt === undefined)) return false;
	if (value.agentRunId !== undefined) {
		if (value.status === "preparing" || value.startedAt === undefined) return false;
		if (value.status === "running" ? value.finishedAt !== undefined : !validTimestamp(value.finishedAt) || value.finishedAt < value.startedAt) return false;
	}
	if (value.plan.remoteAccess.mode === "workspace_write") return value.fullAccessApprovals === undefined;
	if (!isRecord(value.fullAccessApprovals) ||
		!validApproval(value.fullAccessApprovals.restart, "restart", value.plan.restart.command)) return false;
	return value.plan.verify
		? validApproval(value.fullAccessApprovals.verify, "verify", value.plan.verify.command)
		: value.fullAccessApprovals.verify === undefined;
}

function isPlan(value: unknown): value is DeploymentRun["plan"] {
	if (!isRecord(value) || typeof value.profilePath !== "string" || typeof value.profileHash !== "string" ||
		typeof value.project !== "string" || !isRecord(value.remoteAccess) ||
		!isRecord(value.target) || typeof value.target.host !== "string" ||
		(value.target.name !== undefined && typeof value.target.name !== "string") ||
		!isRecord(value.module) || typeof value.module.id !== "string" || typeof value.module.name !== "string" ||
		!isRecord(value.targetBinding) || !Number.isSafeInteger(value.targetBinding.port) ||
		!Number.isSafeInteger(value.targetBinding.credentialAuthVersion) ||
		(value.targetBinding.workspaceRevision !== undefined && !Number.isSafeInteger(value.targetBinding.workspaceRevision)) ||
		(value.targetBinding.hostKeyAlgorithm !== undefined && typeof value.targetBinding.hostKeyAlgorithm !== "string") ||
		!nonEmptyString(value.targetBinding.remoteUser) || !nonEmptyString(value.targetBinding.hostKeyFingerprint) ||
		!nonEmptyString(value.targetBinding.credentialId) || !nonEmptyString(value.targetBinding.writableRoot) ||
		!isRecord(value.build) || typeof value.build.cwd !== "string" ||
		typeof value.build.command !== "string" || typeof value.build.artifact !== "string" ||
		!isRecord(value.upload) || typeof value.upload.remotePath !== "string" ||
		!isRecord(value.restart) || typeof value.restart.command !== "string" ||
		(value.verify !== undefined && (!isRecord(value.verify) || typeof value.verify.command !== "string"))) return false;
	return value.remoteAccess.mode === "workspace_write" ||
		(value.remoteAccess.mode === "full_access" &&
			oneOf(value.remoteAccess.reason, ["sandbox_unavailable", "sandbox_partial_enforcement"]));
}

function isStages(value: unknown): value is DeploymentRun["stages"] {
	return isRecord(value) && DEPLOY_STAGES.every((stage) => isStage(value[stage]));
}

function isStage(value: unknown): value is DeploymentRun["stages"][DeployStage] {
	return isRecord(value) && oneOf(value.status, STAGE_STATUSES) && typeof value.log === "string" &&
		(value.error === undefined || typeof value.error === "string") &&
		(value.exitCode === undefined || Number.isSafeInteger(value.exitCode)) &&
		(value.failureCode === undefined || (typeof value.failureCode === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(value.failureCode))) &&
		(value.operationId === undefined || (typeof value.operationId === "string" && value.operationId.trim().length > 0 && value.operationId.length <= 200)) &&
		(value.safeDetails === undefined || validSafeDetails(value.safeDetails)) &&
		(value.startedAt === undefined || validTimestamp(value.startedAt)) &&
		(value.finishedAt === undefined || validTimestamp(value.finishedAt)) &&
		(value.progress === undefined || (isRecord(value.progress) && Number.isSafeInteger(value.progress.current) && Number(value.progress.current) >= 0 &&
			Number.isSafeInteger(value.progress.total) && Number(value.progress.total) >= 0));
}

function validSafeDetails(value: unknown): value is Record<string, string | number | boolean> {
	return isRecord(value) &&
		Object.keys(value).length <= 32 && Object.entries(value).every(([key, detail]) =>
			/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(key) &&
			(typeof detail === "boolean" || (typeof detail === "string" && detail.length <= 1_000) ||
				(typeof detail === "number" && Number.isFinite(detail))));
}

function validApproval(value: unknown, stage: DeploymentRemoteStage, command: string): value is DeploymentFullAccessApproval {
	if (!isRecord(value) || !nonEmptyString(value.id) || value.stage !== stage || value.command !== command ||
		!oneOf(value.status, ["pending", "approved", "rejected"]) || !validTimestamp(value.requestedAt)) return false;
	if (value.status === "pending") return value.resolvedAt === undefined && value.expiresAt === undefined;
	if (!validTimestamp(value.resolvedAt)) return false;
	return value.status === "approved"
		? validTimestamp(value.expiresAt) && value.expiresAt > value.resolvedAt
		: value.expiresAt === undefined;
}

function validTimestamp(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000;
}

export function isDeploymentDiscovery(value: unknown): value is DeploymentDiscovery {
	return isRecord(value) && typeof value.host === "string" && Array.isArray(value.profiles) &&
		value.profiles.every((profile) => isRecord(profile) && typeof profile.file === "string" &&
			typeof profile.project === "string" && isRecord(profile.target) && typeof profile.target.host === "string" &&
			(profile.target.name === undefined || typeof profile.target.name === "string") &&
			Array.isArray(profile.modules) && profile.modules.every((module) => isRecord(module) &&
				typeof module.id === "string" && typeof module.name === "string")) &&
		Array.isArray(value.errors) && value.errors.every((error) => isRecord(error) &&
			typeof error.file === "string" && typeof error.message === "string") &&
		(value.latest === null || isDeploymentRun(value.latest));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
	return typeof value === "string" && options.some((option) => option === value);
}
