export const DEPLOY_STAGES = ["prepare", "build", "upload", "restart", "verify"] as const;
export type DeployStage = typeof DEPLOY_STAGES[number];
export type DeployStatus = "preparing" | "running" | "recovering" | "success" | "failed" | "cancelled";
export type DeploymentRemoteStage = "restart" | "verify";
export type DeploymentExecutableStage = Exclude<DeployStage, "prepare">;
export type DeploymentFullAccessReason = "deployment_policy" | "sandbox_unavailable" | "sandbox_partial_enforcement" | "sandbox_scope_exceeded";
export type DeploymentRemoteAccess = { mode: "workspace_write" } | { mode: "full_access"; reason: DeploymentFullAccessReason };

interface DeploymentRemoteCommand {
	command: string;
	writePaths?: string[];
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
	toolName?: "remote_sandbox_exception";
	reason?: DeploymentFullAccessReason;
}

export interface DeploymentProfileSummary {
	file: string;
	project: string;
	target: { host: string; name?: string };
	modules: { id: string; name: string }[];
}

interface DeploymentPlanBase {
	profilePath: string;
	profileHash: string;
	remoteAccess: DeploymentRemoteAccess;
	project: string;
	target: { host: string; name?: string };
	targetBinding: { workspaceRevision?: number; port: number; hostKeyAlgorithm?: string; hostKeyFingerprint: string; credentialId: string; credentialAuthVersion: number; remoteUser: string; writableRoot: string };
	module: { id: string; name: string };
	restart: DeploymentRemoteCommand;
	verify?: DeploymentRemoteCommand;
}

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

export function deploymentRemoteStageAccess(plan: DeploymentPlan, stage: DeploymentRemoteStage): DeploymentRemoteAccess {
	return plan[stage]?.access ?? plan.remoteAccess;
}

export interface DeploymentRun {
	id: string;
	sessionId: string;
	workspaceId: string;
	discussionId?: string;
	createdAt: number;
	startedAt?: number;
	updatedAt: number;
	agentRunId?: string;
	agentRunHistory?: string[];
	planningAgentRunId?: string;
	planningProposalHash?: string;
	finishedAt?: number;
	status: DeployStatus;
	plan: DeploymentPlan;
	planRevision?: number;
	initialPlan?: DeploymentPlanV2;
	stageAttempts?: Partial<Record<DeploymentExecutableStage, { planRevision: number; agentRunId: string; result: DeploymentRun["stages"][DeployStage] }[]>>;
	recoveries?: {
		id: string;
		stage: DeploymentExecutableStage;
		reason: string;
		plan: DeploymentPlanV2;
		baseRevision: number;
		status: "pending" | "approved" | "rejected";
		agentRunId: string;
		proposedAt: number;
		resolvedAt?: number;
	}[];
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

export interface DeploymentDiscussion {
	id: string;
	sessionId: string;
	workspaceId: string;
	status: "discussing" | "proposed" | "cancelled";
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
		writableRoot: string;
	};
	createdAt: number;
	updatedAt: number;
	deploymentRunId?: string;
}

export interface DeploymentDiscovery {
	host: string;
	profiles: DeploymentProfileSummary[];
	errors: { file: string; message: string }[];
	latest: DeploymentRun | null;
	activeDiscussion: DeploymentDiscussion | null;
}

const DEPLOY_STATUSES: readonly DeployStatus[] = ["preparing", "running", "recovering", "success", "failed", "cancelled"];
const STAGE_STATUSES: readonly DeploymentRun["stages"][DeployStage]["status"][] = ["pending", "running", "success", "failed", "skipped"];

export function isDeploymentRun(value: unknown): value is DeploymentRun {
	if (!isRecord(value)) return false;
	const plan = value.plan;
	if (!isPlan(plan)) return false;
	if (typeof value.id !== "string" || typeof value.sessionId !== "string" ||
		typeof value.workspaceId !== "string" || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) ||
		value.updatedAt < value.createdAt || !oneOf(value.status, DEPLOY_STATUSES) ||
		(value.discussionId !== undefined && !nonEmptyString(value.discussionId)) ||
		(value.startedAt !== undefined && (!validTimestamp(value.startedAt) || value.startedAt < value.createdAt || value.startedAt > value.updatedAt)) ||
		(value.finishedAt !== undefined && (!validTimestamp(value.finishedAt) || value.finishedAt < value.createdAt)) ||
		(value.agentRunId !== undefined && (typeof value.agentRunId !== "string" || !value.agentRunId)) ||
		(value.agentRunHistory !== undefined && (!Array.isArray(value.agentRunHistory) || value.agentRunHistory.length > 128 ||
			!value.agentRunHistory.every(validAgentRunId) || new Set(value.agentRunHistory).size !== value.agentRunHistory.length ||
			(value.agentRunId !== undefined && !value.agentRunHistory.includes(value.agentRunId)))) ||
		(value.planningAgentRunId !== undefined && !validAgentRunId(value.planningAgentRunId)) ||
		(value.planningProposalHash !== undefined && (value.planningAgentRunId === undefined || typeof value.planningProposalHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.planningProposalHash))) ||
		(value.error !== undefined && typeof value.error !== "string") || !isStages(value.stages) ||
		(value.planRevision !== undefined && !positiveInteger(value.planRevision)) ||
		(value.initialPlan !== undefined && (!isPlan(value.initialPlan) || value.initialPlan.version !== 2)) ||
		!validStageAttempts(value.stageAttempts, value.planRevision ?? 1) ||
		!validRecoveries(value.recoveries, value.initialPlan, plan, value.planRevision ?? 1)) return false;
	if (value.planningAgentRunId !== undefined && plan.version !== 2) return false;
	if ((value.agentRunId === undefined) !== (value.startedAt === undefined)) return false;
	if (value.agentRunId !== undefined) {
		if (value.status === "preparing" || value.startedAt === undefined) return false;
		if (value.status === "running" || value.status === "recovering"
			? value.finishedAt !== undefined : !validTimestamp(value.finishedAt) || value.finishedAt < value.startedAt) return false;
	}
	if (value.status === "recovering" && (plan.version !== 2 || value.agentRunId === undefined)) return false;
	if ((value.recoveries === undefined) !== (value.initialPlan === undefined)) return false;
	const remoteStages: DeploymentRemoteStage[] = plan.verify ? ["restart", "verify"] : ["restart"];
	const fullAccessStages = remoteStages.filter((stage) => deploymentRemoteStageAccess(plan, stage).mode === "full_access");
	if (fullAccessStages.length === 0) return value.fullAccessApprovals === undefined;
	const approvals = value.fullAccessApprovals;
	if (!isRecord(approvals) ||
		Object.keys(approvals).some((stage) => !fullAccessStages.includes(stage as DeploymentRemoteStage))) return false;
	return fullAccessStages.every((stage) => validApproval(approvals[stage], stage,
		plan[stage]!.command, deploymentRemoteStageAccess(plan, stage), plan[stage]!.access !== undefined));
}

function validStageAttempts(value: unknown, revision: number): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || Object.keys(value).some((stage) => !["build", "upload", "restart", "verify"].includes(stage))) return false;
	return Object.values(value).every((attempts) => Array.isArray(attempts) && attempts.length <= 64 && attempts.every((attempt) =>
		isRecord(attempt) && positiveInteger(attempt.planRevision) && attempt.planRevision <= revision &&
		validAgentRunId(attempt.agentRunId) && isStage(attempt.result) &&
		["success", "failed", "skipped"].includes(attempt.result.status)));
}

function validRecoveries(value: unknown, initialPlan: unknown, currentPlan: DeploymentRun["plan"], revision: number): boolean {
	if (value === undefined) return initialPlan === undefined && revision === 1;
	if (!isPlan(initialPlan) || initialPlan.version !== 2 || currentPlan.version !== 2 ||
		!samePlanIdentity(initialPlan, currentPlan) || !Array.isArray(value) || value.length < 1 || value.length > 64) return false;
	let approved = 0;
	let previousPlan: DeploymentRun["plan"] = initialPlan;
	for (const [index, recovery] of value.entries()) {
		if (!isRecord(recovery) || !validAgentRunId(recovery.id) || !validAgentRunId(recovery.agentRunId) ||
			!boundedText(recovery.reason, 1_000) || !["build", "upload", "restart", "verify"].includes(String(recovery.stage)) ||
			!["pending", "approved", "rejected"].includes(String(recovery.status)) || !isPlan(recovery.plan) || recovery.plan.version !== 2 ||
			!positiveInteger(recovery.baseRevision) || recovery.baseRevision !== approved + 1 || !validTimestamp(recovery.proposedAt) ||
			!samePlanIdentity(previousPlan, recovery.plan) || !onlyRecoveryStageChanged(previousPlan, recovery.plan, recovery.stage) ||
			(recovery.status === "pending" ? recovery.resolvedAt !== undefined || index !== value.length - 1
				: !validTimestamp(recovery.resolvedAt) || recovery.resolvedAt < recovery.proposedAt)) return false;
		if (recovery.status === "approved") { approved++; previousPlan = recovery.plan; }
	}
	return revision === approved + 1 && JSON.stringify(previousPlan) === JSON.stringify(currentPlan);
}

function samePlanIdentity(a: DeploymentRun["plan"], b: DeploymentRun["plan"]): boolean {
	const explicitStageAccess = a.restart.access !== undefined && b.restart.access !== undefined;
	return (explicitStageAccess || JSON.stringify(a.remoteAccess) === JSON.stringify(b.remoteAccess)) &&
		(["profilePath", "profileHash", "project", "target", "targetBinding", "module"] as const)
			.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

function onlyRecoveryStageChanged(before: DeploymentRun["plan"], after: DeploymentRun["plan"], stage: unknown): boolean {
	if (before.version !== 2 || after.version !== 2) return false;
	const unchanged = stage === "build" ? ["restart", "verify", "remoteAccess"] : stage === "upload" ? ["buildSteps", "restart", "verify", "remoteAccess"]
		: stage === "restart" ? ["buildSteps", "artifacts", "verify"] : ["buildSteps", "artifacts", "restart"];
	return unchanged.every((key) => JSON.stringify(before[key as keyof typeof before]) === JSON.stringify(after[key as keyof typeof after]));
}

export function isDeploymentDiscussion(value: unknown): value is DeploymentDiscussion {
	if (!isRecord(value) || !keysMatch(value,
		["id", "sessionId", "workspaceId", "status", "revision", "profileFile", "profileHash", "projectRoot", "project",
			"module", "targetBinding", "createdAt", "updatedAt"], ["deploymentRunId"]) ||
		!validAgentRunId(value.id) || !validAgentRunId(value.sessionId) || !validAgentRunId(value.workspaceId) ||
		!oneOf(value.status, ["discussing", "proposed", "cancelled"]) ||
		!positiveInteger(value.revision) ||
		!boundedText(value.profileFile, 200) || !/^deploy-[a-zA-Z0-9._-]+\.md$/u.test(value.profileFile) ||
		typeof value.profileHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.profileHash) ||
		!absoluteLocalPath(value.projectRoot) || !boundedText(value.project, 200) ||
		!isDiscussionModule(value.module) || !isDiscussionTarget(value.targetBinding) ||
		!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) return false;
	return value.status === "proposed"
		? validAgentRunId(value.deploymentRunId)
		: value.deploymentRunId === undefined;
}

function isDiscussionModule(value: unknown): value is DeploymentDiscussion["module"] {
	return isRecord(value) && exactKeys(value, ["id", "name"]) &&
		boundedText(value.id, 80) && /^[a-z0-9][a-z0-9_-]*$/u.test(value.id) && boundedText(value.name, 200);
}

function isDiscussionTarget(value: unknown): value is DeploymentDiscussion["targetBinding"] {
	return isRecord(value) && exactKeys(value,
		["hostname", "port", "workspaceRevision", "hostKeyAlgorithm", "hostKeyFingerprint", "credentialId",
			"credentialAuthVersion", "remoteUser", "writableRoot"]) &&
		boundedText(value.hostname, 255) && positiveInteger(value.port) && value.port <= 65535 &&
		positiveInteger(value.workspaceRevision) && boundedText(value.hostKeyAlgorithm, 200) &&
		boundedText(value.hostKeyFingerprint, 500) && validAgentRunId(value.credentialId) &&
		positiveInteger(value.credentialAuthVersion) && boundedText(value.remoteUser, 200) &&
		absoluteRemoteDirectory(value.writableRoot);
}

function keysMatch(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	return required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max &&
		value === value.trim() && !/[\0-\x1f]/u.test(value);
}

function absoluteRemoteDirectory(value: unknown): value is string {
	return boundedText(value, 2048) && value.startsWith("/") &&
		(value === "/" || (!value.endsWith("/") && normalizedSegments(value.slice(1), "/")));
}

function absoluteRemoteWritePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 2048 && value.startsWith("/") &&
		!/[\0-\x1f]/u.test(value) &&
		(value === "/" || (!value.endsWith("/") && normalizedSegments(value.slice(1), "/")));
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
		!validRemoteCommand(value.restart) ||
		(value.verify !== undefined && !validRemoteCommand(value.verify))) return false;
	if (!isRemoteAccess(value.remoteAccess)) return false;
	if (value.restart.access !== undefined || value.verify?.access !== undefined) {
		if (value.restart.access === undefined || (value.verify !== undefined && value.verify.access === undefined)) return false;
		const fullAccess = [value.restart.access, value.verify?.access].find((access) => access?.mode === "full_access");
		if (!sameRemoteAccess(value.remoteAccess, fullAccess ?? { mode: "workspace_write" })) return false;
	}
	if (value.version === 2) {
		if (value.build !== undefined || value.upload !== undefined || !Array.isArray(value.buildSteps) || !Array.isArray(value.artifacts) ||
			value.buildSteps.length < 1 || value.buildSteps.length > 8 || value.artifacts.length < 1 || value.artifacts.length > 16 ||
			!validCommand(value.restart.command) || (value.verify !== undefined && !validCommand(value.verify.command))) return false;
		const buildsValid = value.buildSteps.every((step) => isRecord(step) && exactKeys(step, ["cwd", "command"]) &&
			absoluteLocalPath(step.cwd) && validCommand(step.command));
		const artifactsValid = value.artifacts.every((artifact) => isRecord(artifact) && exactKeys(artifact, ["source", "remotePath"]) &&
			absoluteLocalPath(artifact.source) && remoteFilePath(artifact.remotePath));
		return buildsValid && artifactsValid &&
			new Set(value.artifacts.map((artifact) => artifact.remotePath)).size === value.artifacts.length;
	}
	return value.version === undefined && value.buildSteps === undefined && value.artifacts === undefined &&
		isRecord(value.build) && typeof value.build.cwd === "string" && typeof value.build.command === "string" && typeof value.build.artifact === "string" &&
		isRecord(value.upload) && typeof value.upload.remotePath === "string";
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validAgentRunId(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\0-\x1f]/u.test(value);
}

function validCommand(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 4000 && !/[\0-\x08\x0b\x0c\x0e-\x1f]/u.test(value);
}

function absoluteLocalPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\0-\x1f]/u.test(value)) return false;
	if (value.startsWith("/")) return normalizedSegments(value.slice(1), "/");
	if (/^[A-Za-z]:[\\/]/u.test(value)) return normalizedSegments(value.slice(3), /[\\/]/u);
	const unc = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.exec(value);
	return unc !== null && normalizedSegments(value.slice(unc[0].length), "\\");
}

function normalizedSegments(value: string, separator: string | RegExp): boolean {
	if (value === "") return true;
	const segments = value.split(separator);
	if (segments.at(-1) === "") segments.pop();
	return segments.every((part) => part !== "" && part !== "." && part !== "..");
}

function remoteFilePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 1 && value.length <= 2048 && value.startsWith("/") && !value.endsWith("/") &&
		!/[\0-\x1f]/u.test(value) && value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..");
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

function validRemoteCommand(value: unknown): value is DeploymentRemoteCommand {
	if (!isRecord(value) || typeof value.command !== "string" ||
		Object.keys(value).some((key) => key !== "command" && key !== "writePaths" && key !== "access")) return false;
	if (value.writePaths !== undefined && (!Array.isArray(value.writePaths) || value.writePaths.length < 1 ||
		value.writePaths.length > 16 || !value.writePaths.every(absoluteRemoteWritePath) ||
		new Set(value.writePaths).size !== value.writePaths.length)) return false;
	return value.access === undefined || isRemoteAccess(value.access);
}

function isRemoteAccess(value: unknown): value is DeploymentRemoteAccess {
	return isRecord(value) && (value.mode === "workspace_write"
		? exactKeys(value, ["mode"])
		: value.mode === "full_access" && exactKeys(value, ["mode", "reason"]) &&
			oneOf(value.reason, ["deployment_policy", "sandbox_unavailable", "sandbox_partial_enforcement", "sandbox_scope_exceeded"]));
}

function sameRemoteAccess(a: DeploymentRemoteAccess, b: DeploymentRemoteAccess): boolean {
	return a.mode === b.mode && (a.mode === "workspace_write" || (b.mode === "full_access" && a.reason === b.reason));
}

function validApproval(value: unknown, stage: DeploymentRemoteStage, command: string,
	access: DeploymentRemoteAccess, explicitAccess: boolean): value is DeploymentFullAccessApproval {
	if (access.mode !== "full_access") return false;
	if (!isRecord(value) || !nonEmptyString(value.id) || value.stage !== stage || value.command !== command ||
		!oneOf(value.status, ["pending", "approved", "rejected"]) || !validTimestamp(value.requestedAt)) return false;
	if ((value.toolName !== undefined && value.toolName !== "remote_sandbox_exception") ||
		(value.reason !== undefined && value.reason !== access.reason) ||
		(explicitAccess && access.reason !== "deployment_policy" &&
			(value.toolName !== "remote_sandbox_exception" || value.reason !== access.reason))) return false;
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
		(value.latest === null || isDeploymentRun(value.latest)) &&
		(value.activeDiscussion === null || (isDeploymentDiscussion(value.activeDiscussion) && value.activeDiscussion.status === "discussing"));
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
