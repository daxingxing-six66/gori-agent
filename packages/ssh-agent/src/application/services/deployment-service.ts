import { defaultSandboxWritableRoots, sameSandboxWritableRoots } from "../../domain/sandbox-writable-roots.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEPLOY_STAGES, DeploymentError, parseDeploymentProfile,
	type DeploymentDiscussion, type DeploymentExecutableStage, type DeploymentPlan, type DeploymentPlanV2, type DeploymentProfile,
	type DeploymentRecoveryProposal, type DeploymentRemoteAccess, type DeploymentRemoteCommand, type DeploymentRemoteStage,
	type DeploymentRun, type DeployStage,
} from "../../domain/deployment.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { WorkspaceRepository } from "../repositories/workspace-repository.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";
import type { CommandOperationService } from "./command-operation-service.ts";
import type { FileTransferService } from "./file-transfer-service.ts";
import type { DeploymentHistoryPosition, DeploymentRepository } from "../repositories/deployment-repository.ts";
import type { DeploymentDiscussionRepository } from "../repositories/deployment-discussion-repository.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import type { WorkspaceEventHub } from "../workspace-event-hub.ts";
import type { SessionLifecycleCoordinator, SessionUseLease } from "./session-lifecycle-coordinator.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { CommandOperation } from "../../domain/command-operation.ts";
import type { SshFailureCode, SshSafeDetail } from "../../domain/ssh-failure.ts";
import { RemoteSandboxApprovalStore, type FullAccessRequest } from "./remote-sandbox-approval-store.ts";
import { validateDeploymentProposal, type DeploymentPlanProposal } from "../deployment-plan-proposal.ts";
import { validateRecoveryInput, type DeploymentRecoveryInput } from "../deployment-recovery-proposal.ts";
import type { RemoteSandboxRoute } from "./remote-sandbox-routing.ts";
import { SessionSandboxPolicy } from "./session-sandbox-policy.ts";

const LOG_LIMIT = 128 * 1024;
const FULL_ACCESS_APPROVAL_TTL_MS = 5 * 60_000;
const DEPLOYMENT_COMMAND_CWD = "/";
const SKILL_PATH = fileURLToPath(new URL("../../../resources/skills/gori-deployment-spec/SKILL.md", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../../../resources/skills/gori-deployment-spec/references/profile-schema.md", import.meta.url));

export interface DeploymentProfileSummary {
	file: string;
	project: string;
	target: DeploymentProfile["target"];
	modules: Pick<DeploymentProfile["modules"][number], "id" | "name">[];
}

type AgentDeployStage = DeploymentExecutableStage;
const AGENT_STAGES: readonly AgentDeployStage[] = ["build", "upload", "restart", "verify"];

interface ActiveDeployment { stage: AgentDeployStage; controller: AbortController; task: Promise<DeploymentRun> }
interface ClaimedDeployment { lease?: SessionUseLease; sessionId: string; agentRunId: string }

interface DeploymentServiceOptions {
	sessions: SessionRepository;
	workspaces: WorkspaceRepository;
	targets: SshTargetResolver;
	commands: Pick<CommandOperationService, "submit" | "preflightGuard">;
	sandboxApprovals: RemoteSandboxApprovalStore;
	transfers: Pick<FileTransferService, "create" | "upload" | "get" | "listDirectory">;
	repository: DeploymentRepository;
	discussions?: DeploymentDiscussionRepository;
	transactions?: TransactionRunner;
	events: WorkspaceEventHub;
	localCwd: string;
	lifecycle?: SessionLifecycleCoordinator;
	cancelAgentRun?: (sessionId: string, agentRunId: string) => Promise<void>;
	/** Runtime-provided read-only sandbox probe shared with ordinary remote commands. */
	assessRemoteSandbox?: (target: SshTargetSnapshot, declaredWritePaths: readonly string[], signal: AbortSignal) => Promise<RemoteSandboxRoute>;
}

class DeploymentStageCommandError extends DeploymentError {
	readonly exitCode?: number;
	readonly failureCode?: SshFailureCode;
	readonly safeDetails?: Record<string, SshSafeDetail>;

	constructor(operation: Pick<CommandOperation, "exitCode" | "failure">, stage: DeploymentRemoteStage) {
		super("deployment_remote_failed", operation.failure?.message ?? `Remote ${stage} command failed`, 409);
		this.exitCode = operation.exitCode;
		this.failureCode = operation.failure?.code;
		this.safeDetails = operation.failure?.safeDetails === undefined ? undefined : { ...operation.failure.safeDetails };
	}
}

export class DeploymentService {
	private readonly active = new Map<string, ActiveDeployment>();
	private readonly claimed = new Map<string, ClaimedDeployment>();
	private readonly finishing = new Map<string, Promise<void>>();
	private readonly lastLogPublication = new Map<string, number>();
	private readonly proposals = new Map<string, Promise<DeploymentRun>>();
	private closing = false;
	private readonly options: DeploymentServiceOptions;
	private readonly sandboxPolicy: SessionSandboxPolicy;

	constructor(options: DeploymentServiceOptions) {
		this.options = options;
		this.sandboxPolicy = new SessionSandboxPolicy(options.sessions);
	}

	private async resolveRemoteCommand(sessionId: string, target: SshTargetSnapshot, proposed: { command: string; writePaths?: string[] },
		signal: AbortSignal): Promise<DeploymentRemoteCommand> {
		if (await this.sandboxPolicy.mode(sessionId) === "full_access") {
			return { ...proposed, access: { mode: "full_access", reason: "session_sandbox_disabled" } };
		}
		const route = await this.options.assessRemoteSandbox?.(target, proposed.writePaths ?? [], signal);
		const access: DeploymentRemoteAccess = route?.mode === "workspace_write" ? { mode: "workspace_write" }
			: route?.mode === "full_access" ? { mode: "full_access", reason: route.reason === "write_path_outside_sandbox"
				? "sandbox_scope_exceeded" : "sandbox_unavailable" }
			: { mode: "full_access", reason: "sandbox_unavailable" };
		return { command: proposed.command, ...(proposed.writePaths === undefined ? {} : { writePaths: [...proposed.writePaths] }), access };
	}

	private async requireCurrentSandboxException(run: DeploymentRun, target: SshTargetSnapshot,
		stage: DeploymentRemoteStage, signal: AbortSignal): Promise<void> {
		const access = remoteStageAccess(run.plan, stage);
		if (access.mode !== "full_access" || access.reason !== "sandbox_unavailable" || !this.options.assessRemoteSandbox) return;
		const route = await this.options.assessRemoteSandbox(target, run.plan[stage]?.writePaths ?? [], signal);
		if (route.mode !== "full_access" || route.reason !== "sandbox_unavailable")
			throw new DeploymentError("deployment_sandbox_route_changed", "The remote sandbox changed since this Full Access decision; review a new deployment plan", 409);
	}

	/** Read-only preview for Chat tool authorization; execution still rechecks plan and Guard. */
	previewRemoteStage(sessionId: string, deploymentRunId: string, stage: DeploymentRemoteStage):
		{ command: string; mode: DeploymentRemoteAccess["mode"]; sessionAuthorized?: true } | undefined {
		const run = this.get(sessionId, deploymentRunId);
		const command = run.plan[stage];
		const access = remoteStageAccess(run.plan, stage);
		return command ? { command: command.command, mode: access.mode,
			...(sessionAuthorizedAccess(access) ? { sessionAuthorized: true as const } : {}) } : undefined;
	}

	async listProfiles(sessionId: string): Promise<{ host: string; profiles: DeploymentProfileSummary[]; errors: { file: string; message: string }[]; latest: DeploymentRun | null; activeDiscussion: DeploymentDiscussion | null }> {
		const context = await this.context(sessionId);
		const profiles: DeploymentProfileSummary[] = [];
		const errors: { file: string; message: string }[] = [];
		for (const file of await profileFiles(context.root)) {
			try {
				const { profile } = await loadProfile(context.root, file);
				if (profile.target.host !== context.host) continue;
				profiles.push({ file, project: profile.project, target: profile.target, modules: profile.modules.map(({ id, name }) => ({ id, name })) });
			} catch (error) {
				errors.push({ file, message: error instanceof Error ? error.message : "Invalid deployment profile" });
			}
		}
		return { host: context.host, profiles, errors, latest: this.options.repository.latest(sessionId) ?? null,
			activeDiscussion: this.activeDiscussion(sessionId) };
	}

	activeDiscussion(sessionId: string): DeploymentDiscussion | null {
		return this.options.discussions?.findActive(sessionId) ?? null;
	}

	getDiscussion(sessionId: string, id: string): DeploymentDiscussion {
		const discussion = this.discussionRepository().find(sessionId, id);
		if (!discussion) throw new DeploymentError("deployment_discussion_not_found", "Deployment discussion was not found", 404);
		return discussion;
	}

	async beginDiscussion(sessionId: string, file: string, moduleId: string): Promise<DeploymentDiscussion> {
		if (this.closing) throw new DeploymentError("deployment_unavailable", "Deployment service is closing", 503);
		const context = await this.context(sessionId);
		const { profile, hash } = await loadProfile(context.root, file);
		const module = profile.modules.find((entry) => entry.id === moduleId);
		if (profile.target.host !== context.host || !module)
			throw new DeploymentError("deployment_module_not_found", "Deployment module is unavailable for this Workspace", 404);
		const target = await this.options.targets.resolve(sessionId);
		if (target.workspaceId !== context.workspaceId || target.hostname !== context.host)
			throw new DeploymentError("deployment_target_mismatch", "Workspace SSH target changed", 409);
		const now = Date.now();
		const discussion: DeploymentDiscussion = {
			id: randomUUID(), sessionId, workspaceId: context.workspaceId, status: "discussing", revision: 1,
			profileFile: file, profileHash: hash, projectRoot: context.root, project: profile.project,
			module: { id: module.id, name: module.name },
			targetBinding: discussionTarget(target), createdAt: now, updatedAt: now,
		};
		let previous: DeploymentDiscussion | undefined;
		let previousAgentRunId: string | undefined;
		await this.discussionTransaction(() => {
			const repository = this.discussionRepository();
			const active = repository.findActive(sessionId);
			if (active) {
				previousAgentRunId = repository.findLatestRunBinding(active.id)?.agentRunId;
				previous = { ...active, status: "cancelled", revision: active.revision + 1,
					updatedAt: Math.max(now, active.updatedAt + 1) };
				if (!repository.updateDiscussing(previous, active.revision)) throw discussionConflict();
			}
			repository.insert(discussion);
		});
		if (previous) this.publishDiscussion(previous);
		this.publishDiscussion(discussion);
		if (previousAgentRunId) await this.cancelPlanningRun(sessionId, previousAgentRunId);
		return discussion;
	}

	async cancelDiscussion(sessionId: string, id: string): Promise<DeploymentDiscussion> {
		let cancelled: DeploymentDiscussion | undefined;
		let agentRunId: string | undefined;
		let changed = false;
		await this.discussionTransaction(() => {
			const current = this.getDiscussion(sessionId, id);
			if (current.status === "cancelled") { cancelled = current; return; }
			if (current.status !== "discussing") throw discussionConflict();
			agentRunId = this.discussionRepository().findLatestRunBinding(current.id)?.agentRunId;
			cancelled = { ...current, status: "cancelled", revision: current.revision + 1,
				updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
			if (!this.discussionRepository().updateDiscussing(cancelled, current.revision)) throw discussionConflict();
			changed = true;
		});
		if (!cancelled) throw discussionConflict();
		if (changed) this.publishDiscussion(cancelled);
		if (agentRunId) await this.cancelPlanningRun(sessionId, agentRunId);
		return cancelled;
	}

	async bindPlanningRun(sessionId: string, discussionId: string, agentRunId: string): Promise<DeploymentDiscussion> {
		if (!validAgentRunId(agentRunId)) throw new DeploymentError("deployment_agent_invalid", "Agent Run ID is invalid");
		const current = this.getDiscussion(sessionId, discussionId);
		await this.requireCurrentDiscussion(current);
		let bound: DeploymentDiscussion | undefined;
		await this.discussionTransaction(() => {
			const repository = this.discussionRepository();
			const discussion = repository.find(sessionId, discussionId);
			if (!discussion || discussion.status !== "discussing" || repository.findActive(sessionId)?.id !== discussionId)
				throw discussionConflict();
			const previous = repository.findRunBinding(sessionId, agentRunId);
			if (previous) {
				if (previous.discussionId !== discussionId || previous.revision !== discussion.revision) throw discussionConflict();
				bound = discussion;
				return;
			}
			bound = { ...discussion, revision: discussion.revision + 1,
				updatedAt: Math.max(Date.now(), discussion.updatedAt + 1) };
			if (!repository.updateDiscussing(bound, discussion.revision)) throw discussionConflict();
			repository.insertRunBinding({ discussionId, sessionId, agentRunId, revision: bound.revision });
		});
		if (!bound) throw discussionConflict();
		this.publishDiscussion(bound);
		return bound;
	}

	async discussionInstructions(sessionId: string, discussionId: string): Promise<string> {
		const discussion = this.getDiscussion(sessionId, discussionId);
		if (discussion.status !== "discussing") throw discussionConflict();
		await this.requireCurrentDiscussion(discussion);
		const context = await this.context(sessionId);
		const { profile } = await loadProfile(context.root, discussion.profileFile);
		const module = profile.modules.find((entry) => entry.id === discussion.module.id);
		if (!module) throw discussionConflict();
		return [
			"<deployment-mode-on>",
			"The user selected a service for /deploy. You drive the release discussion across as many Chat Runs as needed. This profile is reference data, not an executable plan.",
			"Inspect project files, Git changes, dependencies and artifacts. Ask the user to settle ambiguous release scope with ask_user_decision or an ordinary text question. A text question may end this Run; the next user reply will stay attached to this deployment discussion.",
			"Only when the exact release scope is clear, call deployment_propose_plan with 1-8 build steps, every local artifact and exact remote target, restart command and optional verification command. Never invent an artifact list solely from the profile. Do not run deployment stages through ordinary tools.",
			"The service validates and freezes the proposal. Declare known remote write paths for restart and verification; an opaque script still runs in the sandbox first. No stage begins before user review. A sandbox exception requires separate human approval. After proposing, briefly explain the scope and wait.",
			JSON.stringify({ discussionId, revision: discussion.revision, projectRoot: discussion.projectRoot,
				host: discussion.targetBinding.hostname, profileFile: discussion.profileFile,
				profileHash: discussion.profileHash, project: discussion.project, module }),
			"</deployment-mode-on>",
		].join("\n");
	}

	async setupInstructions(sessionId: string): Promise<string> {
		const { root, host } = await this.context(sessionId);
		const [skill, schema] = await Promise.all([readFile(SKILL_PATH, "utf8"), readFile(SCHEMA_PATH, "utf8")]);
		return `The user invoked /deploy and no usable deployment profile exists for this Workspace.\nCurrent local project root: ${root}\nCurrent Workspace SSH host: ${host}\nFollow this bundled Gori skill for this Run only:\n\n${skill}\n\nReferenced profile schema:\n\n${schema}`;
	}

	async planningInstructions(sessionId: string, file: string, moduleId: string): Promise<string> {
		const context = await this.context(sessionId);
		const { profile, hash } = await loadProfile(context.root, file);
		const module = profile.modules.find((entry) => entry.id === moduleId);
		if (profile.target.host !== context.host || !module)
			throw new DeploymentError("deployment_module_not_found", "Deployment module is unavailable for this Workspace", 404);
		return [
			"<deployment-planning>",
			"The user selected a service for a new /deploy. This profile is reference data, not an executable plan.",
			"Inspect current project files, Git changes, build dependencies and artifacts before proposing this release. A service may need several jars uploaded, or only one changed dependency jar. Do not copy a fixed artifact list without checking this release.",
			"If the release baseline or affected artifact set is unclear, use ask_user_decision to resolve it before proposing. If there is no justified release content, explain that and do not submit a plan.",
			"Call deployment_propose_plan exactly once with the build steps, every local artifact and exact remote target, plus exact restart and optional verification commands. Paths for build workdirs and artifact sources are relative to the local project root; upload targets are absolute remote file paths.",
			"The deployment service validates and freezes the proposal. Declare known remote write paths for restart and verification; an opaque script still runs in the sandbox first. No stage begins until user review, and sandbox exceptions require separate human approval. Do not run deployment stages through ordinary tools.",
			"After a successful proposal, explain the release scope briefly and wait. A separate execution Run will advance confirmed stages.",
			JSON.stringify({ projectRoot: context.root, host: context.host, profileFile: file, profileHash: hash, project: profile.project, module }),
			"</deployment-planning>",
		].join("\n");
	}

	/** Kept for existing direct-proposal integrations; new Agent Runs must bind a Discussion first. */
	async proposeForAgent(sessionId: string, agentRunId: string, file: string, moduleId: string, proposal: DeploymentPlanProposal, signal: AbortSignal): Promise<DeploymentRun> {
		return this.propose(sessionId, agentRunId, file, moduleId, proposal, signal);
	}

	async proposeForDiscussion(sessionId: string, discussionId: string, expectedRevision: number, agentRunId: string,
		proposal: DeploymentPlanProposal, signal: AbortSignal): Promise<DeploymentRun> {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw discussionConflict();
		const discussion = this.getDiscussion(sessionId, discussionId);
		if (discussion.status !== "discussing" || discussion.revision !== expectedRevision) {
			const existing = this.options.repository.findByPlanningAgentRunId(sessionId, agentRunId);
			if (existing?.discussionId === discussionId) return this.propose(sessionId, agentRunId,
				discussion.profileFile, discussion.module.id, proposal, signal, { id: discussionId, revision: expectedRevision });
			throw discussionConflict();
		}
		const binding = this.discussionRepository().findRunBinding(sessionId, agentRunId);
		if (binding?.discussionId !== discussionId || binding.revision !== expectedRevision) throw discussionConflict();
		await this.requireCurrentDiscussion(discussion);
		return this.propose(sessionId, agentRunId, discussion.profileFile, discussion.module.id, proposal, signal,
			{ id: discussionId, revision: expectedRevision });
	}

	private async propose(sessionId: string, agentRunId: string, file: string, moduleId: string,
		proposal: DeploymentPlanProposal, signal: AbortSignal, discussion?: { id: string; revision: number }): Promise<DeploymentRun> {
		signal.throwIfAborted();
		if (!validAgentRunId(agentRunId)) throw new DeploymentError("deployment_agent_invalid", "Agent Run ID is invalid");
		if (this.closing) throw new DeploymentError("deployment_unavailable", "Deployment service is closing", 503);
		const normalized = validateDeploymentProposal(proposal);
		const proposalHash = createHash("sha256").update(JSON.stringify({ file, moduleId, discussionId: discussion?.id, proposal: normalized })).digest("hex");
		const key = `${sessionId}:${agentRunId}`;
		const active = this.proposals.get(key);
		if (active) {
			const run = await active;
			if (run.planningProposalHash !== proposalHash || run.discussionId !== discussion?.id)
				throw new DeploymentError("deployment_proposal_conflict", "This Agent Run already proposed another plan", 409);
			return run;
		}
		const task = this.createProposedPlan(sessionId, agentRunId, file, moduleId, normalized, proposalHash, signal, discussion);
		this.proposals.set(key, task);
		try { return await task; }
		finally { if (this.proposals.get(key) === task) this.proposals.delete(key); }
	}

	private async createProposedPlan(sessionId: string, agentRunId: string, file: string, moduleId: string, proposal: DeploymentPlanProposal,
		proposalHash: string, signal: AbortSignal, discussion?: { id: string; revision: number }): Promise<DeploymentRun> {
		const existing = this.options.repository.findByPlanningAgentRunId(sessionId, agentRunId);
		if (existing) {
			if (existing.planningProposalHash !== proposalHash || existing.discussionId !== discussion?.id)
				throw new DeploymentError("deployment_proposal_conflict", "This Agent Run already proposed another plan", 409);
			return existing;
		}
		const lease = this.options.lifecycle?.acquireUse(sessionId, "deployment_run");
		try {
			const context = await this.context(sessionId);
			const { profile, path, hash } = await loadProfile(context.root, file);
			signal.throwIfAborted();
			if (discussion) {
				const current = this.getDiscussion(sessionId, discussion.id);
				if (current.status !== "discussing" || current.revision !== discussion.revision ||
					current.projectRoot !== context.root || current.profileHash !== hash ||
					current.project !== profile.project || current.workspaceId !== context.workspaceId) throw discussionConflict();
			}
			const module = profile.modules.find((entry) => entry.id === moduleId);
			if (profile.target.host !== context.host || !module)
				throw new DeploymentError("deployment_module_not_found", "Deployment module is unavailable for this Workspace", 404);
			// Both the Discussion and legacy entry points validate this immutable input in propose().
			const requested = proposal;
			const buildSteps = await Promise.all(requested.buildSteps.map(async (step) => {
				const cwd = inside(context.root, step.workdir);
				const resolved = await realpath(cwd).catch(() => { throw new DeploymentError("deployment_workdir_unavailable", "Build workdir does not exist", 409); });
				if (!contained(context.root, resolved) || !(await stat(resolved)).isDirectory())
					throw new DeploymentError("deployment_workdir_invalid", "Build workdir must stay in the project", 409);
				return { cwd: resolved, command: step.command };
			}));
			const allowedDirectories = profile.version === 1
				? [posix.dirname(profile.modules.find((entry) => entry.id === moduleId)!.upload.target)]
				: profile.modules.find((entry) => entry.id === moduleId)!.upload.allowedDirectories;
			const artifacts = requested.artifacts.map(({ source, target }) => {
				if (!allowedDirectories.some((directory) => target.startsWith(`${directory === "/" ? "" : directory}/`)))
					throw new DeploymentError("deployment_upload_outside_profile", "Upload target is outside the profile's allowed directories", 409);
				return { source: inside(context.root, source), remotePath: target };
			});
			const target = await this.options.targets.resolve(sessionId);
			if (target.hostname !== context.host) throw new DeploymentError("deployment_target_mismatch", "Workspace SSH target changed", 409);
			if (discussion && (target.workspaceId !== context.workspaceId ||
				!sameDiscussionTarget(this.getDiscussion(sessionId, discussion.id).targetBinding, target)))
				throw discussionConflict();
			for (const artifact of artifacts) {
				await this.ensureRemoteDestination(context.workspaceId, target.defaultCwd, artifact.remotePath);
				const directory = allowedDirectories.find((entry) => artifact.remotePath.startsWith(`${entry === "/" ? "" : entry}/`));
				if (!directory) throw new DeploymentError("deployment_upload_outside_profile", "Upload target is outside the profile's allowed directories", 409);
				await this.ensureRemoteDestination(context.workspaceId, directory, artifact.remotePath);
			}
			for (const command of [requested.restart.command, requested.verify?.command]) {
				if (!command) continue;
				const decision = await this.options.commands.preflightGuard(sessionId, command);
				if (!decision.allowed) throw new DeploymentError("deployment_guard_blocked", decision.matchedRule?.reason ?? "Workspace Guard blocked a deployment command", 409);
			}
			const restart = await this.resolveRemoteCommand(sessionId, target, requested.restart, signal);
			const verify = requested.verify === undefined ? undefined : await this.resolveRemoteCommand(sessionId, target, requested.verify, signal);
			signal.throwIfAborted();
			if (this.closing) throw new DeploymentError("deployment_unavailable", "Deployment service is closing", 503);
			const now = Date.now();
			const plan: DeploymentPlan = {
				version: 2, profilePath: path, profileHash: hash, remoteAccess: summarizeRemoteAccess(restart, verify),
				project: profile.project, target: { ...profile.target },
				targetBinding: { workspaceRevision: target.workspaceRevision, port: target.port, hostKeyAlgorithm: target.hostKeyAlgorithm,
					hostKeyFingerprint: target.hostKeyFingerprint, credentialId: target.credentialId,
					credentialAuthVersion: target.credentialAuthVersion, remoteUser: target.remoteUser, writableRoot: target.defaultCwd, sandboxWritableRoots: targetSandboxRoots(target) },
				module: { id: module.id, name: module.name }, buildSteps, artifacts,
				restart,
				...(verify ? { verify } : {}),
			};
			const run: DeploymentRun = {
				id: randomUUID(), sessionId, workspaceId: context.workspaceId, planningAgentRunId: agentRunId, planningProposalHash: proposalHash,
				...(discussion ? { discussionId: discussion.id } : {}),
				status: "preparing", plan, planRevision: 1, stages: initialStages(now),
				...fullAccessApprovalsForPlan(plan, now),
				createdAt: now, updatedAt: now,
			};
			let proposedDiscussion: DeploymentDiscussion | undefined;
			try {
				if (discussion) {
					await this.discussionTransaction(() => {
						const current = this.getDiscussion(sessionId, discussion.id);
						const binding = this.discussionRepository().findRunBinding(sessionId, agentRunId);
						if (current.status !== "discussing" || current.revision !== discussion.revision ||
							binding?.discussionId !== discussion.id || binding.revision !== discussion.revision) throw discussionConflict();
						proposedDiscussion = { ...current, status: "proposed", revision: current.revision + 1,
							deploymentRunId: run.id, updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
						if (!this.discussionRepository().updateDiscussing(proposedDiscussion, current.revision)) throw discussionConflict();
						this.options.repository.insert(run);
					});
				} else this.options.repository.insert(run);
			}
			catch (error) {
				const current = this.options.repository.findByPlanningAgentRunId(sessionId, agentRunId);
				if (current && current.planningProposalHash === proposalHash && current.discussionId === discussion?.id) return current;
				if (current) throw new DeploymentError("deployment_proposal_conflict", "This Agent Run already proposed another plan", 409);
				throw error;
			}
			if (proposedDiscussion) this.publishDiscussion(proposedDiscussion);
			this.publish(run);
			if (signal.aborted) {
				await this.finishPlanningAgent(sessionId, agentRunId, "cancelled");
				signal.throwIfAborted();
			}
			return run;
		} finally { lease?.release(); }
	}

	async finishPlanningAgent(sessionId: string, agentRunId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
		if (status === "completed") return;
		const run = this.options.repository.findByPlanningAgentRunId(sessionId, agentRunId);
		if (!run || run.status !== "preparing") return;
		const now = Date.now();
		for (const approval of Object.values(run.fullAccessApprovals ?? {})) {
			if (approval?.status === "pending") { approval.status = "rejected"; approval.resolvedAt = now; }
		}
		run.status = "cancelled";
		run.error = status === "cancelled" ? "Deployment planning was cancelled before confirmation" : "Deployment planning failed before confirmation";
		run.finishedAt = now;
		run.updatedAt = nextUpdatedAt(run);
		if (this.options.repository.cancelPreparing(run)) this.publish(run);
	}

	async prepare(sessionId: string, file: string, moduleId: string): Promise<DeploymentRun> {
		const lease = this.options.lifecycle?.acquireUse(sessionId, "deployment_run");
		try { return await this.preparePlan(sessionId, file, moduleId); }
		finally { lease?.release(); }
	}

	private async preparePlan(sessionId: string, file: string, moduleId: string): Promise<DeploymentRun> {
		if (this.closing) throw new DeploymentError("deployment_unavailable", "Deployment service is closing", 503);
		const context = await this.context(sessionId);
		const { profile, path, hash } = await loadProfile(context.root, file);
		if (profile.version !== 1)
			throw new DeploymentError("deployment_agent_required", "This profile requires a model-proposed deployment plan", 409);
		if (profile.target.host !== context.host)
			throw new DeploymentError("deployment_target_mismatch", "Profile does not target the current Workspace host", 409);
		const module = profile.modules.find(({ id }) => id === moduleId);
		if (!module) throw new DeploymentError("deployment_module_not_found", "Deployment module was not found", 404);
		const cwd = inside(context.root, module.workdir);
		const cwdReal = await realpath(cwd).catch(() => { throw new DeploymentError("deployment_workdir_unavailable", "Build workdir does not exist", 409); });
		if (!contained(context.root, cwdReal) || !(await stat(cwdReal)).isDirectory())
			throw new DeploymentError("deployment_workdir_invalid", "Build workdir must be a directory inside the project", 409);
		const artifact = inside(cwdReal, module.build.artifact);
		const target = await this.options.targets.resolve(sessionId);
		if (target.hostname !== context.host)
			throw new DeploymentError("deployment_target_mismatch", "Workspace SSH target changed", 409);
		await this.ensureRemoteDestination(context.workspaceId, target.defaultCwd, module.upload.target);
		for (const command of [module.restart.command, module.verify?.command]) {
			if (!command) continue;
			const decision = await this.options.commands.preflightGuard(sessionId, command);
			if (!decision.allowed) throw new DeploymentError("deployment_guard_blocked", decision.matchedRule?.reason ?? "Workspace Guard blocked a deployment command", 409);
		}
		const signal = new AbortController().signal;
		const restart = await this.resolveRemoteCommand(sessionId, target, module.restart, signal);
		const verify = module.verify === undefined ? undefined : await this.resolveRemoteCommand(sessionId, target, module.verify, signal);
		const plan: DeploymentPlan = {
			profilePath: path,
			profileHash: hash,
			remoteAccess: summarizeRemoteAccess(restart, verify),
			project: profile.project,
			target: { ...profile.target },
			targetBinding: {
				workspaceRevision: target.workspaceRevision, port: target.port,
				hostKeyAlgorithm: target.hostKeyAlgorithm, hostKeyFingerprint: target.hostKeyFingerprint, credentialId: target.credentialId,
				credentialAuthVersion: target.credentialAuthVersion, remoteUser: target.remoteUser, writableRoot: target.defaultCwd, sandboxWritableRoots: targetSandboxRoots(target),
			},
			module: { id: module.id, name: module.name },
			build: { cwd: cwdReal, command: module.build.command, artifact },
			upload: { remotePath: module.upload.target },
			restart,
			...(verify === undefined ? {} : { verify }),
		};
		const now = Date.now();
		const run: DeploymentRun = {
			id: randomUUID(), sessionId, workspaceId: context.workspaceId, status: "preparing", plan,
			stages: initialStages(now),
			...fullAccessApprovalsForPlan(plan, now),
			createdAt: now, updatedAt: now,
		};
		this.options.repository.insert(run);
		this.publish(run);
		return run;
	}

	get(sessionId: string, id: string): DeploymentRun {
		return this.options.repository.find(sessionId, id) ?? missing();
	}

	async bindRecoveryAgent(sessionId: string, id: string, agentRunId: string): Promise<DeploymentRun> {
		if (!validAgentRunId(agentRunId)) throw new DeploymentError("deployment_agent_invalid", "Agent Run ID is invalid");
		const run = this.get(sessionId, id);
		if (run.status !== "recovering" || run.plan.version !== 2 || run.recoveries?.at(-1)?.status === "approved" ||
			run.recoveries?.at(-1)?.status === "pending")
			throw new DeploymentError("deployment_recovery_unavailable", "Deployment is not awaiting a recovery proposal", 409);
		await this.requireCurrentPlan(run);
		const expectedUpdatedAt = run.updatedAt;
		rememberAgentRun(run, agentRunId);
		run.agentRunId = agentRunId;
		run.updatedAt = nextUpdatedAt(run);
		if (!this.options.repository.updateRecovering(run, expectedUpdatedAt))
			throw new DeploymentError("deployment_recovery_conflict", "Deployment recovery changed; reload it", 409);
		this.publish(run);
		return run;
	}

	async proposeRecoveryForAgent(sessionId: string, id: string, agentRunId: string, expectedRevision: number,
		input: DeploymentRecoveryInput, signal: AbortSignal): Promise<DeploymentRun> {
		signal.throwIfAborted();
		const run = this.get(sessionId, id);
		this.requireAgent(run, agentRunId);
		if (run.status !== "recovering" || run.plan.version !== 2 ||
			!Number.isSafeInteger(expectedRevision) || expectedRevision !== (run.planRevision ?? 1) ||
			!AGENT_STAGES.some((stage) => run.stages[stage].status === "failed"))
			throw new DeploymentError("deployment_recovery_unavailable", "Deployment has no failed stage to repair", 409);
		const context = await this.context(sessionId);
		const normalized = validateRecoveryInput(input, run.plan, context.root);
		if (run.stages[normalized.stage].status !== "failed")
			throw new DeploymentError("deployment_recovery_stage_mismatch", "Only the failed stage can be repaired", 409);
		await this.requireCurrentPlan(run);
		const nextPlan = await this.resolveRecoveryPlan(run, normalized.stage, normalized.proposal, context.root, signal);
		const existing = run.recoveries?.at(-1);
		if (existing?.status === "pending") {
			if (existing.agentRunId === agentRunId && existing.baseRevision === expectedRevision &&
				existing.reason === normalized.reason && JSON.stringify(existing.plan) === JSON.stringify(nextPlan)) return run;
			throw new DeploymentError("deployment_recovery_conflict", "A recovery proposal is already awaiting review", 409);
		}
		if ((run.stageAttempts?.[normalized.stage]?.length ?? 0) >= 64 || (run.recoveries?.length ?? 0) >= 64)
			throw new DeploymentError("deployment_recovery_limit", "This deployment reached its recovery history limit", 409);
		const proposedAt = Date.now();
		const proposal: DeploymentRecoveryProposal = {
			id: randomUUID(), stage: normalized.stage, reason: normalized.reason, plan: nextPlan,
			baseRevision: expectedRevision, status: "pending", agentRunId, proposedAt,
		};
		const expectedUpdatedAt = run.updatedAt;
		run.planRevision ??= 1;
		run.initialPlan ??= run.plan;
		run.recoveries = [...(run.recoveries ?? []), proposal];
		run.updatedAt = nextUpdatedAt(run);
		if (!this.options.repository.updateRecovering(run, expectedUpdatedAt))
			throw new DeploymentError("deployment_recovery_conflict", "Deployment recovery changed; reload it", 409);
		this.publish(run);
		return run;
	}

	async decideRecovery(sessionId: string, id: string, proposalId: string, approved: boolean): Promise<DeploymentRun> {
		const run = this.get(sessionId, id);
		const proposal = run.recoveries?.at(-1);
		if (!proposal || proposal.id !== proposalId)
			throw new DeploymentError("deployment_recovery_not_found", "Recovery proposal is unavailable", 404);
		if (proposal.status !== "pending") {
			if ((proposal.status === "approved") === approved) return run;
			throw new DeploymentError("deployment_recovery_conflict", "Recovery proposal was already resolved", 409);
		}
		if (run.status !== "recovering") throw new DeploymentError("deployment_recovery_conflict", "Deployment is no longer awaiting recovery", 409);
		if (proposal.baseRevision !== (run.planRevision ?? 1) || run.stages[proposal.stage].status !== "failed")
			throw new DeploymentError("deployment_recovery_conflict", "Deployment stage changed; reload it", 409);
		if (approved) await this.requireCurrentPlan(run);
		const expectedUpdatedAt = run.updatedAt;
		proposal.status = approved ? "approved" : "rejected";
		proposal.resolvedAt = Date.now();
		if (approved) {
			if (run.plan.version !== 2) throw new DeploymentError("deployment_recovery_unavailable", "Historical deployment plans cannot be repaired", 409);
			run.initialPlan ??= run.plan;
			run.plan = proposal.plan;
			run.planRevision = proposal.baseRevision + 1;
			run.stages[proposal.stage] = { status: "pending", log: "" };
			delete run.error;
			delete run.finishedAt;
			const next: NonNullable<DeploymentRun["fullAccessApprovals"]> = {};
			for (const stage of (["restart", "verify"] as const)) {
				const command = run.plan[stage];
				if (!command || !requiresSandboxException(remoteStageAccess(run.plan, stage))) continue;
				const prior = run.fullAccessApprovals?.[stage];
				next[stage] = run.stages[stage].status === "success" && prior ? prior
					: fullAccessApproval(stage, command.command, remoteStageAccess(run.plan, stage), proposal.resolvedAt);
			}
			if (Object.keys(next).length > 0) run.fullAccessApprovals = next;
			else delete run.fullAccessApprovals;
		}
		run.updatedAt = nextUpdatedAt(run);
		if (!this.options.repository.updateRecovering(run, expectedUpdatedAt)) {
			const current = this.get(sessionId, id);
			const resolved = current.recoveries?.at(-1);
			if (resolved?.id === proposalId && (resolved.status === "approved") === approved && resolved.status !== "pending") return current;
			throw new DeploymentError("deployment_recovery_conflict", "Deployment recovery changed; reload it", 409);
		}
		this.publish(run);
		return run;
	}

	private async resolveRecoveryPlan(run: DeploymentRun, stage: DeploymentExecutableStage, proposal: DeploymentPlanProposal, root: string,
		signal: AbortSignal): Promise<DeploymentPlanV2> {
		if (run.plan.version !== 2) throw new DeploymentError("deployment_recovery_unavailable", "Historical deployment plans cannot be repaired", 409);
		const buildSteps = await Promise.all(proposal.buildSteps.map(async (step) => {
			const cwd = await realpath(inside(root, step.workdir)).catch(() => { throw new DeploymentError("deployment_workdir_unavailable", "Build workdir does not exist", 409); });
			if (!contained(root, cwd) || !(await stat(cwd)).isDirectory())
				throw new DeploymentError("deployment_workdir_invalid", "Build workdir must stay in the project", 409);
			return { cwd, command: step.command };
		}));
		const artifacts = proposal.artifacts.map(({ source, target }) => ({ source: inside(root, source), remotePath: target }));
		for (const artifact of artifacts) {
			signal.throwIfAborted();
			await this.ensureRemoteDestination(run.workspaceId, run.plan.targetBinding.writableRoot, artifact.remotePath);
			await this.ensureRemoteProfileDestination(run, artifact.remotePath);
		}
		for (const command of [proposal.restart.command, proposal.verify?.command]) {
			if (!command) continue;
			const decision = await this.options.commands.preflightGuard(run.sessionId, command);
			if (!decision.allowed) throw new DeploymentError("deployment_guard_blocked", decision.matchedRule?.reason ?? "Workspace Guard blocked a deployment command", 409);
		}
		const target = await this.requireBoundTarget(run);
		const restart = stage === "restart" ? await this.resolveRemoteCommand(run.sessionId, target, proposal.restart, signal) : run.plan.restart;
		const verify = stage === "verify" && proposal.verify ? await this.resolveRemoteCommand(run.sessionId, target, proposal.verify, signal) : run.plan.verify;
		signal.throwIfAborted();
		return { ...run.plan, buildSteps, artifacts, remoteAccess: stage === "restart" || stage === "verify"
			? summarizeRemoteAccess(restart, verify) : run.plan.remoteAccess, restart,
			...(verify ? { verify } : {}) };
	}

	latest(sessionId: string): DeploymentRun | null {
		return this.options.repository.latest(sessionId) ?? null;
	}

	listHistory(sessionId: string, limit = 20, cursor?: string): { runs: DeploymentRun[]; hasMore: boolean; nextCursor: string | null } {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
			throw new DeploymentError("deployment_request_invalid", "History limit must be between 1 and 50", 400);
		const before = cursor === undefined ? undefined : decodeHistoryCursor(sessionId, cursor);
		const rows = this.options.repository.listRecent(sessionId, limit + 1, before);
		const hasMore = rows.length > limit;
		const runs = rows.slice(0, limit);
		const last = runs.at(-1);
		return { runs, hasMore, nextCursor: hasMore && last ? encodeHistoryCursor(sessionId, last) : null };
	}

	decideFullAccess(sessionId: string, id: string, stage: "restart" | "verify", approvalId: string, approved: boolean): DeploymentRun {
		if (this.closing) throw new DeploymentError("deployment_unavailable", "Deployment service is closing", 503);
		const run = this.get(sessionId, id);
		if (remoteStageAccess(run.plan, stage).mode !== "full_access")
			throw new DeploymentError("deployment_approval_unavailable", "This deployment does not require Full Access", 409);
		const approval = run.fullAccessApprovals?.[stage];
		if (!approval || approval.id !== approvalId || approval.command !== run.plan[stage]?.command)
			throw new DeploymentError("deployment_approval_not_found", "Full Access approval does not match the deployment plan", 404);
		if (approval.status === "rejected" || (approval.status === "approved" && !approved)) {
			if (approval.status === "rejected" && !approved) return run;
			throw new DeploymentError("deployment_approval_conflict", "Full Access approval was already resolved", 409);
		}
		if (run.status !== "preparing" && !(run.status === "recovering" && run.recoveries?.at(-1)?.status === "approved"))
			throw new DeploymentError("deployment_approval_conflict", "Deployment is no longer awaiting approval", 409);
		const now = Date.now();
		if (approval.status === "approved" && approved && (approval.expiresAt ?? 0) > now) return run;
		if (approved) {
			const expectedUpdatedAt = run.updatedAt;
			approval.status = "approved";
			approval.resolvedAt = now;
			approval.expiresAt = now + FULL_ACCESS_APPROVAL_TTL_MS;
			run.updatedAt = nextUpdatedAt(run);
			if (!(run.status === "preparing" ? this.options.repository.approvePreparing(run, expectedUpdatedAt)
				: this.options.repository.updateRecovering(run, expectedUpdatedAt)))
				throw new DeploymentError("deployment_approval_conflict", "Deployment approval changed; reload the plan", 409);
		} else {
			const expectedUpdatedAt = run.updatedAt;
			const wasPreparing = run.status === "preparing";
			approval.status = "rejected";
			approval.resolvedAt = now;
			delete approval.expiresAt;
			run.status = "cancelled";
			run.finishedAt = now;
			run.updatedAt = nextUpdatedAt(run);
			if (wasPreparing) {
				if (!this.options.repository.cancelPreparing(run))
					throw new DeploymentError("deployment_approval_conflict", "Deployment is no longer awaiting approval", 409);
			} else if (!this.options.repository.cancelRecovering(run, expectedUpdatedAt))
				throw new DeploymentError("deployment_approval_conflict", "Deployment changed before rejection", 409);
		}
		this.publish(run);
		return run;
	}

	async claimForAgent(sessionId: string, id: string, agentRunId: string): Promise<DeploymentRun> {
		if (!validAgentRunId(agentRunId))
			throw new DeploymentError("deployment_agent_invalid", "Agent Run ID is invalid");
		if (this.closing) throw new DeploymentError("deployment_unavailable", "Deployment service is closing", 503);
		const run = this.get(sessionId, id);
		if (run.agentRunId === agentRunId) return run;
		const recovering = run.status === "recovering" && run.recoveries?.at(-1)?.status === "approved";
		if (!recovering && (run.status !== "preparing" || run.agentRunId !== undefined))
			throw new DeploymentError("deployment_agent_mismatch", "Deployment belongs to another Agent Run or is no longer awaiting confirmation", 409);
		if (recovering && !AGENT_STAGES.some((stage) => run.stages[stage].status === "pending"))
			throw new DeploymentError("deployment_recovery_unavailable", "Recovery has no stage to resume", 409);
		this.requireFullAccessApprovals(run);
		const lease = this.options.lifecycle?.acquireUse(sessionId, "deployment_run");
		let leaseTransferred = false;
		try {
			await this.requireCurrentPlan(run);
			const target = await this.requireBoundTarget(run);
			for (const stage of ["restart", "verify"] as const) {
				if (run.plan[stage] && run.stages[stage].status !== "success")
					await this.requireCurrentSandboxException(run, target, stage, new AbortController().signal);
			}
			this.requireFullAccessApprovals(run);
			run.status = "running";
			rememberAgentRun(run, agentRunId);
			run.agentRunId = agentRunId;
			const expectedUpdatedAt = run.updatedAt;
			run.startedAt ??= Math.max(Date.now(), run.createdAt);
			run.updatedAt = nextUpdatedAt(run);
			if (!(recovering ? this.options.repository.claimRecovering(run, expectedUpdatedAt) : this.options.repository.claim(run))) {
				const current = this.get(sessionId, id);
				if (current.agentRunId === agentRunId) return current;
				if (current.status === "preparing" || current.status === "recovering")
					throw new DeploymentError("deployment_workspace_busy", "Another deployment is running for this Workspace", 409);
				throw new DeploymentError("deployment_agent_mismatch", "Deployment was claimed or cancelled by another request", 409);
			}
			this.claimed.set(id, { lease, sessionId, agentRunId });
			leaseTransferred = true;
			if (run.fullAccessApprovals) {
				// Approval must be fresh when deployment starts. The exact one-use grants then
				// remain valid until their stage runs or this deployment ends.
				for (const stage of ["restart", "verify"] as const) {
					const command = run.plan[stage];
					if (command && requiresSandboxException(remoteStageAccess(run.plan, stage)) && run.stages[stage].status !== "success")
						this.options.sandboxApprovals.approve(this.fullAccessRequest(run, stage, command.command));
				}
			}
			this.publish(run);
			return run;
		} finally {
			if (!leaseTransferred) lease?.release();
		}
	}

	async executeStageForAgent(sessionId: string, id: string, agentRunId: string, stage: AgentDeployStage, signal: AbortSignal): Promise<DeploymentRun> {
		if (!AGENT_STAGES.includes(stage)) throw new DeploymentError("deployment_stage_invalid", "Unknown deployment stage");
		const run = this.get(sessionId, id);
		this.requireAgent(run, agentRunId);
		const settling = this.finishing.get(id);
		if (settling) { await settling; return this.get(sessionId, id); }
		if (run.stages[stage].status === "success" || run.stages[stage].status === "skipped" || run.stages[stage].status === "failed") return run;
		if (run.status !== "running") throw new DeploymentError("deployment_not_running", "Deployment is no longer running", 409);
		if (this.claimed.get(id)?.agentRunId !== agentRunId)
			throw new DeploymentError("deployment_agent_unavailable", "Deployment Agent claim is no longer active", 409);
		const active = this.active.get(id);
		if (active) {
			if (active.stage === stage) return active.task;
			throw new DeploymentError("deployment_stage_busy", "Another deployment stage is running", 409);
		}
		const next = AGENT_STAGES.find((name) => run.stages[name].status === "pending");
		if (next !== stage || AGENT_STAGES.slice(0, AGENT_STAGES.indexOf(stage)).some((name) =>
			run.stages[name].status !== "success" && run.stages[name].status !== "skipped"))
			throw new DeploymentError("deployment_stage_out_of_order", "Deployment stages must run in order", 409);
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		let task!: Promise<DeploymentRun>;
		task = Promise.resolve().then(() => this.executeAgentStage(run, stage, controller.signal)).finally(() => {
			signal.removeEventListener("abort", onAbort);
			if (this.active.get(id)?.task === task) this.active.delete(id);
		});
		this.active.set(id, { stage, controller, task });
		return task;
	}

	async finishAgent(sessionId: string, id: string, agentRunId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
		this.requireAgent(this.get(sessionId, id), agentRunId);
		const existing = this.finishing.get(id);
		if (existing) { await existing; return; }
		const task = this.settleAgentRun(sessionId, id, agentRunId, status);
		this.finishing.set(id, task);
		try { await task; }
		finally { if (this.finishing.get(id) === task) this.finishing.delete(id); }
	}

	private async settleAgentRun(sessionId: string, id: string, agentRunId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
		const initial = this.get(sessionId, id);
		this.requireAgent(initial, agentRunId);
		try {
			const active = this.active.get(id);
			if (active) {
				active.controller.abort(new Error(`Agent Run ${status}`));
				// A failed persistence write can reject the stage task while its last
				// durable snapshot still says "running". Settle that snapshot below.
				try { await active.task; } catch { /* Inspect the persisted run below. */ }
			}
			const run = this.get(sessionId, id);
			if (run.status === "running") {
				const endedAt = this.failRunningStage(run, "Agent Run ended before the deployment stage completed; inspect effects before retrying");
				const allDone = AGENT_STAGES.every((stage) => ["success", "skipped"].includes(run.stages[stage].status));
				run.status = status === "completed" && allDone ? "success" : status === "cancelled" ? "cancelled" : "failed";
				run.error = run.status === "success" ? undefined : status === "completed" && !allDone
					? "Agent Run ended before the deployment completed"
					: `Agent Run ${status} before the deployment completed`;
				run.finishedAt = endedAt;
				this.save(run);
			} else if (run.status === "cancelled" && status !== "cancelled") {
				run.status = "failed";
				run.error = status === "completed" ? "Agent Run ended before the deployment completed" : "Agent Run failed";
				run.finishedAt = Math.max(Date.now(), run.startedAt ?? run.createdAt);
				this.save(run);
			}
		} finally {
			this.releaseRun(id);
		}
	}

	private requireAgent(run: DeploymentRun, agentRunId: string): void {
		if (!agentRunId || run.agentRunId !== agentRunId)
			throw new DeploymentError("deployment_agent_mismatch", "Deployment belongs to another Agent Run", 409);
	}

	async cancel(sessionId: string, id: string): Promise<DeploymentRun> {
		let run = this.get(sessionId, id);
		if (run.status === "preparing") {
			run.status = "cancelled";
			run.finishedAt = Date.now();
			run.updatedAt = nextUpdatedAt(run);
			if (this.options.repository.cancelPreparing(run)) { this.publish(run); return run; }
			run = this.get(sessionId, id);
		}
		if (run.agentRunId && run.status === "running") {
			try { await this.finishAgent(sessionId, id, run.agentRunId, "cancelled"); }
			finally { await this.options.cancelAgentRun?.(sessionId, run.agentRunId); }
		}
		if (run.status === "recovering") {
			const expectedUpdatedAt = run.updatedAt;
			run.status = "cancelled";
			run.finishedAt = Math.max(Date.now(), run.startedAt ?? run.createdAt);
			run.updatedAt = nextUpdatedAt(run);
			if (!this.options.repository.cancelRecovering(run, expectedUpdatedAt))
				throw new DeploymentError("deployment_recovery_conflict", "Deployment changed; reload it", 409);
			this.publish(run);
			if (run.agentRunId) await this.options.cancelAgentRun?.(sessionId, run.agentRunId);
		}
		return this.get(sessionId, id);
	}

	async close(): Promise<void> {
		this.closing = true;
		await Promise.allSettled([...this.claimed.entries()].map(async ([id, { sessionId, agentRunId }]) => {
			await this.finishAgent(sessionId, id, agentRunId, "failed");
		}));
	}

	private async executeAgentStage(run: DeploymentRun, stage: AgentDeployStage, signal: AbortSignal): Promise<DeploymentRun> {
		try {
			await this.executePlannedStage(run, stage, signal);
		} catch (error) {
			const endedAt = this.failRunningStage(run, "Deployment stage ended before its result could be saved; inspect effects before retrying");
			run.status = signal.aborted ? "cancelled" : run.plan.version === 2 ? "recovering" : "failed";
			run.error = error instanceof Error ? error.message : "Deployment failed";
			if (run.status === "recovering") delete run.finishedAt;
			else run.finishedAt = endedAt;
			this.save(run);
		} finally {
			if (run.status !== "running") this.releaseRun(run.id);
			this.lastLogPublication.delete(`${run.id}:${stage}`);
		}
		return run;
	}

	/** Stage selection is separate from the Run's success/failure settlement above. */
	private async executePlannedStage(run: DeploymentRun, stage: AgentDeployStage, signal: AbortSignal): Promise<void> {
		switch (stage) {
			case "build":
				await this.build(run, signal);
				break;
			case "upload":
				await this.upload(run, signal);
				break;
			case "restart":
				await this.executeRemoteStage(run, "restart", run.plan.restart.command, signal);
				break;
			case "verify":
				await this.verify(run, signal);
				run.status = "success";
				run.finishedAt = Math.max(Date.now(), run.startedAt ?? run.createdAt);
				this.save(run);
				break;
		}
	}

	private async build(run: DeploymentRun, signal: AbortSignal): Promise<void> {
		await this.stage(run, "build", signal, async () => {
			await this.requireCurrentPlan(run);
			const steps = run.plan.version === 2 ? run.plan.buildSteps : [run.plan.build];
			for (const [index, step] of steps.entries()) {
				const cwdNow = await realpath(step.cwd);
				if (cwdNow !== step.cwd) throw new DeploymentError("deployment_workdir_invalid", "Build workdir changed", 409);
				if (run.plan.version === 2) this.log(run, "build", `Build ${index + 1}/${steps.length}: ${step.cwd}\n`);
				await runLocalBuild(step.command, step.cwd, signal, (line) => this.log(run, "build", line));
			}
			const artifacts = run.plan.version === 2 ? run.plan.artifacts.map((entry) => entry.source) : [run.plan.build.artifact];
			const root = (await this.context(run.sessionId)).root;
			for (const source of artifacts) await this.requireArtifact(run, root, source);
		});
	}

	private async upload(run: DeploymentRun, signal: AbortSignal): Promise<void> {
		await this.stage(run, "upload", signal, async () => {
			await this.requireCurrentPlan(run);
			const root = (await this.context(run.sessionId)).root;
			const planned = run.plan.version === 2 ? run.plan.artifacts : [{ source: run.plan.build.artifact, remotePath: run.plan.upload.remotePath }];
			const files = await Promise.all(planned.map(async (entry) => ({ ...entry, ...await this.requireArtifact(run, root, entry.source) })));
			const total = files.reduce((sum, file) => sum + file.size, 0);
			let completedBytes = 0;
			for (const [index, file] of files.entries()) {
				signal.throwIfAborted();
				const currentFile = await this.requireArtifact(run, root, file.source);
				if (currentFile.path !== file.path || currentFile.size !== file.size)
					throw new DeploymentError("deployment_artifact_changed", "Build artifact changed during upload; inspect remote effects", 409);
				await this.ensureRemoteDestination(run.workspaceId, run.plan.targetBinding.writableRoot, file.remotePath);
				if (run.plan.version === 2) await this.ensureRemoteProfileDestination(run, file.remotePath);
				const transfer = await this.options.transfers.create(run.workspaceId, {
					direction: "upload", remotePath: file.remotePath, totalBytes: file.size, overwrite: true,
				});
				this.assertBoundTarget(run, transfer.target);
				let polling = false;
				let stopped = false;
				const ticker = setInterval(() => {
					if (polling || stopped) return;
					polling = true;
					void this.options.transfers.get(run.workspaceId, transfer.id).then((current) => {
						if (stopped || run.status !== "running") return;
						run.stages.upload.progress = { current: completedBytes + current.bytesTransferred, total };
						this.save(run);
					}).catch(() => undefined).finally(() => { polling = false; });
				}, 300);
				try {
					const result = await this.options.transfers.upload(run.workspaceId, transfer.id, createReadStream(file.path), signal);
					if (result.status !== "completed")
						throw new DeploymentError("deployment_upload_failed", result.failure?.message ?? "Upload did not complete", 409);
					completedBytes += result.bytesTransferred;
					run.stages.upload.progress = { current: completedBytes, total };
					this.log(run, "upload", `Uploaded ${index + 1}/${files.length}: ${file.remotePath} (${result.bytesTransferred} bytes)\n`);
				} finally { stopped = true; clearInterval(ticker); }
			}
		});
	}

	private async requireArtifact(run: DeploymentRun, root: string, source: string): Promise<{ path: string; size: number }> {
		const path = await realpath(source).catch(() => { throw new DeploymentError("deployment_artifact_invalid", "Build artifact is unavailable", 409); });
		const allowedRoot = run.plan.version === 2 ? root : run.plan.build.cwd;
		if (!contained(allowedRoot, path)) throw new DeploymentError("deployment_artifact_invalid", "Build artifact escaped its allowed directory", 409);
		const info = await stat(path);
		if (!info.isFile()) throw new DeploymentError("deployment_artifact_invalid", "Only regular file artifacts are supported", 409);
		return { path, size: info.size };
	}

	private async executeRemoteStage(run: DeploymentRun, stage: DeploymentRemoteStage, command: string, signal: AbortSignal): Promise<void> {
		await this.stage(run, stage, signal, async () => {
			await this.requireCurrentPlan(run);
			await this.remoteCommand(run, stage, command, signal);
		});
	}

	private async verify(run: DeploymentRun, signal: AbortSignal): Promise<void> {
		const verify = run.plan.verify;
		if (verify) {
			await this.executeRemoteStage(run, "verify", verify.command, signal);
			return;
		}
		await this.stage(run, "verify", signal, async () => {
			await this.requireCurrentPlan(run);
			run.stages.verify.log = "No verification command configured";
		}, "skipped");
	}

	private failRunningStage(run: DeploymentRun, reason: string): number {
		let endedAt = Math.max(Date.now(), run.startedAt ?? run.createdAt);
		for (const stage of AGENT_STAGES) {
			const view = run.stages[stage];
			if (view.status !== "running") continue;
			endedAt = Math.max(endedAt, view.startedAt ?? run.createdAt);
			view.status = "failed";
			view.error ??= reason;
			view.finishedAt = endedAt;
			this.recordAttempt(run, stage);
		}
		return endedAt;
	}

	private releaseRun(id: string): void {
		this.options.sandboxApprovals.clearRun(`deployment:${id}`);
		this.claimed.get(id)?.lease?.release();
		this.claimed.delete(id);
		for (const stage of DEPLOY_STAGES) this.lastLogPublication.delete(`${id}:${stage}`);
	}

	private async remoteCommand(run: DeploymentRun, stage: "restart" | "verify", command: string, signal: AbortSignal): Promise<void> {
		const expectedTarget = await this.requireBoundTarget(run);
		await this.requireCurrentSandboxException(run, expectedTarget, stage, signal);
		const access = remoteStageAccess(run.plan, stage);
		const fullAccess = requiresSandboxException(access)
			? this.fullAccessRequest(run, stage, command)
			: undefined;
		const cwd = deploymentCommandCwd(run);
		const result = await this.options.commands.submit({
			sessionId: run.sessionId,
			toolCallId: fullAccess?.toolCallId ?? deploymentToolCallId(run, stage),
			command,
			// Historical deployment_policy plans retain their original root cwd.
			...(cwd === undefined ? {} : { cwd }),
			sandboxPermissions: fullAccess ? "full_access" : "workspace_write",
			...(fullAccess ? { fullAccessApprovalScopeId: fullAccess.agentRunId, justification: fullAccess.justification } : {}),
			expectedTarget,
			expectedSandboxEnabled: !sessionAuthorizedAccess(access),
			signal,
			onEvent: (event) => {
				if ((event.type === "stdout" || event.type === "stderr") && "chunk" in event.data)
					this.log(run, stage, event.data.chunk);
			},
		});
		if (result.operation.id) run.stages[stage].operationId = result.operation.id;
		if (result.operation.status !== "completed")
			throw new DeploymentStageCommandError(result.operation, stage);
	}

	private async requireBoundTarget(run: DeploymentRun): Promise<SshTargetSnapshot> {
		const target = await this.options.targets.resolve(run.sessionId);
		this.assertBoundTarget(run, target);
		const bound = run.plan.targetBinding;
		if (!sameSandboxWritableRoots(targetSandboxRoots(target), bound.sandboxWritableRoots ?? defaultSandboxWritableRoots(bound.writableRoot))) {
			throw new DeploymentError("deployment_sandbox_route_changed", "Session writable directories changed; review a new deployment plan", 409);
		}
		return target;
	}

	/** Recheck the reviewed plan before each side effect; Agent tools can modify project files between stages. */
	private async requireCurrentPlan(run: DeploymentRun): Promise<void> {
		const sessionAuthorized = await this.sandboxPolicy.mode(run.sessionId) === "full_access";
		for (const stage of ["restart", "verify"] as const) {
			if (run.plan[stage] && sessionAuthorizedAccess(remoteStageAccess(run.plan, stage)) !== sessionAuthorized) {
				throw new DeploymentError("deployment_sandbox_route_changed", "Session sandbox setting changed; review a new deployment plan", 409);
			}
		}
		const context = await this.context(run.sessionId);
		if (context.workspaceId !== run.workspaceId || context.host !== run.plan.target.host)
			throw new DeploymentError("deployment_target_mismatch", "Workspace target changed before deployment", 409);
		await this.requireBoundTarget(run);
		const { hash, profile, path } = await loadProfile(context.root, run.plan.profilePath.split(sep).at(-1) ?? "");
		const module = profile.modules.find(({ id }) => id === run.plan.module.id);
		if (path !== run.plan.profilePath || hash !== run.plan.profileHash || !module ||
			profile.project !== run.plan.project || profile.target.host !== run.plan.target.host ||
			module.name !== run.plan.module.name)
			throw new DeploymentError("deployment_profile_changed", "Deployment profile changed; review a new plan", 409);
		if (run.plan.version === 2) {
			for (const step of run.plan.buildSteps) {
				const cwdNow = await realpath(step.cwd).catch(() => { throw new DeploymentError("deployment_workdir_invalid", "Build workdir is unavailable", 409); });
				if (!contained(context.root, cwdNow) || cwdNow !== step.cwd)
					throw new DeploymentError("deployment_workdir_invalid", "Build workdir changed; review a new plan", 409);
			}
			for (const artifact of run.plan.artifacts) {
				if (!contained(context.root, artifact.source))
					throw new DeploymentError("deployment_artifact_invalid", "Build artifact escaped the project", 409);
			}
			return;
		}
		const legacyModule = profile.version === 1 ? profile.modules.find((entry) => entry.id === run.plan.module.id) : undefined;
		if (!legacyModule || legacyModule.build.command !== run.plan.build.command ||
			legacyModule.upload.target !== run.plan.upload.remotePath || legacyModule.restart.command !== run.plan.restart.command ||
			(legacyModule.verify?.command ?? null) !== (run.plan.verify?.command ?? null) ||
			await realpath(inside(context.root, legacyModule.workdir)) !== run.plan.build.cwd ||
			inside(run.plan.build.cwd, legacyModule.build.artifact) !== run.plan.build.artifact)
			throw new DeploymentError("deployment_profile_changed", "Deployment profile changed; review a new plan", 409);
	}

	private requireFullAccessApprovals(run: DeploymentRun): void {
		const now = Date.now();
		const stages: ("restart" | "verify")[] = run.plan.verify ? ["restart", "verify"] : ["restart"];
		for (const stage of stages) {
			if (!requiresSandboxException(remoteStageAccess(run.plan, stage))) continue;
			if (["success", "skipped"].includes(run.stages[stage].status)) continue;
			const approval = run.fullAccessApprovals?.[stage];
			if (!approval || approval.status !== "approved" || approval.command !== run.plan[stage]?.command ||
				(approval.expiresAt ?? 0) <= now)
				throw new DeploymentError("deployment_full_access_approval_required", "Approve each Full Access remote command before starting deployment", 409);
		}
	}

	private fullAccessRequest(run: DeploymentRun, stage: "restart" | "verify", command: string): FullAccessRequest {
		const cwd = deploymentCommandCwd(run);
		const access = remoteStageAccess(run.plan, stage);
		return {
			agentRunId: `deployment:${run.id}`,
			toolCallId: deploymentToolCallId(run, stage),
			sessionId: run.sessionId,
			command,
			...(cwd === undefined ? {} : { cwd }),
			justification: `User approved sandbox exception for /deploy ${stage}: ${access.mode === "full_access" ? access.reason : "unknown"}`,
		};
	}

	private assertBoundTarget(run: DeploymentRun, target: SshTargetSnapshot): void {
		const bound = run.plan.targetBinding;
		if (target.workspaceId !== run.workspaceId || target.hostname !== run.plan.target.host ||
			target.workspaceRevision !== bound.workspaceRevision || target.port !== bound.port ||
			target.hostKeyAlgorithm !== bound.hostKeyAlgorithm ||
			target.hostKeyFingerprint !== bound.hostKeyFingerprint || target.credentialId !== bound.credentialId ||
			target.credentialAuthVersion !== bound.credentialAuthVersion || target.remoteUser !== bound.remoteUser ||
			target.defaultCwd !== bound.writableRoot)
			throw new DeploymentError("deployment_target_mismatch", "Workspace SSH identity changed; review a new plan", 409);
	}

	private async ensureRemoteDestination(workspaceId: string, writableRoot: string, remotePath: string): Promise<void> {
		const [root, parent] = await Promise.all([
			this.options.transfers.listDirectory(workspaceId, writableRoot),
			this.options.transfers.listDirectory(workspaceId, posix.dirname(remotePath)),
		]);
		const relation = posix.relative(root.path, parent.path);
		if (relation === ".." || relation.startsWith("../") || posix.isAbsolute(relation))
			throw new DeploymentError("deployment_upload_outside_root", "Upload destination must be inside the remote Workspace directory", 409);
	}

	private async ensureRemoteProfileDestination(run: DeploymentRun, remotePath: string): Promise<void> {
		const context = await this.context(run.sessionId);
		const { profile, hash } = await loadProfile(context.root, run.plan.profilePath.split(sep).at(-1) ?? "");
		if (hash !== run.plan.profileHash) throw new DeploymentError("deployment_profile_changed", "Deployment profile changed; review a new plan", 409);
		const directories = profile.version === 1
			? (() => {
				const module = profile.modules.find((entry) => entry.id === run.plan.module.id);
				return module ? [posix.dirname(module.upload.target)] : [];
			})()
			: profile.modules.find((entry) => entry.id === run.plan.module.id)?.upload.allowedDirectories ?? [];
		const directory = directories.find((entry) => remotePath.startsWith(`${entry === "/" ? "" : entry}/`));
		if (!directory) throw new DeploymentError("deployment_upload_outside_profile", "Upload target is outside the profile's allowed directories", 409);
		await this.ensureRemoteDestination(run.workspaceId, directory, remotePath);
	}

	private async stage(run: DeploymentRun, name: AgentDeployStage, signal: AbortSignal, action: () => Promise<void>, finalStatus: "success" | "skipped" = "success"): Promise<void> {
		run.stages[name] = { status: "running", log: "", startedAt: Math.max(Date.now(), run.startedAt ?? run.createdAt) };
		this.save(run);
		try {
			signal.throwIfAborted();
			await action();
			signal.throwIfAborted();
			run.stages[name].status = finalStatus;
			run.stages[name].finishedAt = Math.max(Date.now(), run.stages[name].startedAt ?? run.createdAt);
			this.recordAttempt(run, name);
			this.save(run);
		} catch (error) {
			run.stages[name].status = "failed";
			run.stages[name].error = error instanceof Error ? error.message : "Stage failed";
			if (error instanceof DeploymentStageCommandError) {
				if (error.exitCode !== undefined) run.stages[name].exitCode = error.exitCode;
				if (error.failureCode !== undefined) run.stages[name].failureCode = error.failureCode;
				if (error.safeDetails !== undefined) run.stages[name].safeDetails = error.safeDetails;
			}
			run.stages[name].finishedAt = Math.max(Date.now(), run.stages[name].startedAt ?? run.createdAt);
			this.recordAttempt(run, name);
			// The caller persists the stage and Run terminal states together. A
			// running Run with a failed stage is an invalid intermediate snapshot.
			throw error;
		}
	}

	private recordAttempt(run: DeploymentRun, stage: AgentDeployStage): void {
		if (!run.agentRunId) return;
		const attempts = run.stageAttempts ??= {};
		(attempts[stage] ??= []).push({
			planRevision: run.planRevision ?? 1, agentRunId: run.agentRunId,
			result: { ...run.stages[stage], ...(run.stages[stage].progress ? { progress: { ...run.stages[stage].progress } } : {}) },
		});
	}

	private log(run: DeploymentRun, stage: DeployStage, chunk: string): void {
		const view = run.stages[stage];
		view.log = (view.log + chunk).slice(-LOG_LIMIT);
		const key = `${run.id}:${stage}`;
		const now = Date.now();
		if (now - (this.lastLogPublication.get(key) ?? 0) >= 100) {
			this.lastLogPublication.set(key, now);
			this.save(run);
		}
	}

	private save(run: DeploymentRun): void {
		run.updatedAt = nextUpdatedAt(run);
		this.options.repository.update(run);
		this.publish(run);
	}

	private publish(run: DeploymentRun): void {
		this.options.events.publish(run.workspaceId, { type: "deployment.updated", data: run });
	}

	private publishDiscussion(discussion: DeploymentDiscussion): void {
		this.options.events.publish(discussion.workspaceId, { type: "deployment.discussion.updated", data: discussion });
	}

	private discussionRepository(): DeploymentDiscussionRepository {
		if (!this.options.discussions) throw new DeploymentError("deployment_unavailable", "Deployment discussion store is unavailable", 503);
		return this.options.discussions;
	}

	private async discussionTransaction<T>(action: () => T): Promise<T> {
		this.discussionRepository();
		if (!this.options.transactions) throw new DeploymentError("deployment_unavailable", "Deployment transaction support is unavailable", 503);
		return this.options.transactions.run(action);
	}

	private async cancelPlanningRun(sessionId: string, agentRunId: string): Promise<void> {
		try { await this.options.cancelAgentRun?.(sessionId, agentRunId); }
		catch (error) { console.warn("Deployment discussion ended, but its Agent Run could not be cancelled", { sessionId, agentRunId, error }); }
	}

	private async requireCurrentDiscussion(discussion: DeploymentDiscussion): Promise<void> {
		if (discussion.status !== "discussing") throw discussionConflict();
		const context = await this.context(discussion.sessionId);
		if (context.workspaceId !== discussion.workspaceId || context.root !== discussion.projectRoot ||
			context.host !== discussion.targetBinding.hostname) throw discussionConflict();
		const { profile, hash } = await loadProfile(context.root, discussion.profileFile);
		const module = profile.modules.find((entry) => entry.id === discussion.module.id);
		if (hash !== discussion.profileHash || profile.project !== discussion.project ||
			profile.target.host !== discussion.targetBinding.hostname || module?.name !== discussion.module.name) throw discussionConflict();
		const target = await this.options.targets.resolve(discussion.sessionId);
		if (target.workspaceId !== discussion.workspaceId || !sameDiscussionTarget(discussion.targetBinding, target))
			throw discussionConflict();
	}

	private async context(sessionId: string): Promise<{ root: string; host: string; workspaceId: string }> {
		const session = await this.options.sessions.findById(sessionId);
		if (!session) throw new DeploymentError("deployment_session_not_found", "Session not found", 404);
		const workspace = await this.options.workspaces.findById(session.workspaceId);
		if (!workspace) throw new DeploymentError("deployment_workspace_not_found", "Workspace not found", 404);
		const root = await realpath(session.workDir ?? this.options.localCwd).catch(() => { throw new DeploymentError("deployment_workdir_unavailable", "Local project directory is unavailable", 409); });
		if (!(await stat(root)).isDirectory()) throw new DeploymentError("deployment_workdir_unavailable", "Local project path is not a directory", 409);
		return { root, host: workspace.host.hostname, workspaceId: workspace.id };
	}
}

/** Historical plans retain their original remote working-directory behavior. */
function deploymentCommandCwd(run: DeploymentRun): string | undefined {
	return run.plan.remoteAccess.mode === "full_access" && run.plan.remoteAccess.reason === "deployment_policy"
		? DEPLOYMENT_COMMAND_CWD
		: undefined;
}

function remoteStageAccess(plan: DeploymentPlan, stage: DeploymentRemoteStage): DeploymentRemoteAccess {
	return plan[stage]?.access ?? plan.remoteAccess;
}

function sessionAuthorizedAccess(access: DeploymentRemoteAccess): boolean {
	return access.mode === "full_access" && access.reason === "session_sandbox_disabled";
}

function requiresSandboxException(access: DeploymentRemoteAccess): boolean {
	return access.mode === "full_access" && !sessionAuthorizedAccess(access);
}

function summarizeRemoteAccess(restart: DeploymentRemoteCommand, verify?: DeploymentRemoteCommand): DeploymentRemoteAccess {
	return [restart.access, verify?.access].find((access): access is Extract<DeploymentRemoteAccess, { mode: "full_access" }> =>
		access?.mode === "full_access") ?? { mode: "workspace_write" };
}

function fullAccessApproval(stage: DeploymentRemoteStage, command: string, access: DeploymentRemoteAccess, requestedAt: number):
	NonNullable<DeploymentRun["fullAccessApprovals"]>[DeploymentRemoteStage] {
	if (access.mode !== "full_access" || access.reason === "session_sandbox_disabled") throw new Error("Full Access approval requires a sandbox exception");
	return {
		id: randomUUID(), stage, command, status: "pending", requestedAt, reason: access.reason,
		...(access.reason === "deployment_policy" ? {} : { toolName: "remote_sandbox_exception" as const }),
	};
}

function fullAccessApprovalsForPlan(plan: DeploymentPlan, requestedAt: number): Pick<DeploymentRun, "fullAccessApprovals"> | Record<string, never> {
	const approvals: NonNullable<DeploymentRun["fullAccessApprovals"]> = {};
	for (const stage of ["restart", "verify"] as const) {
		const command = plan[stage];
		if (!command) continue;
		const access = remoteStageAccess(plan, stage);
		if (requiresSandboxException(access)) approvals[stage] = fullAccessApproval(stage, command.command, access, requestedAt);
	}
	return Object.keys(approvals).length > 0 ? { fullAccessApprovals: approvals } : {};
}

function deploymentToolCallId(run: DeploymentRun, stage: DeploymentRemoteStage): string {
	return run.planRevision === undefined ? `deploy:${run.id}:${stage}` : `deploy:${run.id}:r${run.planRevision}:${stage}`;
}

function rememberAgentRun(run: DeploymentRun, agentRunId: string): void {
	const previous = run.agentRunHistory ?? (run.agentRunId ? [run.agentRunId] : []);
	if (!previous.includes(agentRunId)) run.agentRunHistory = [...previous.slice(-127), agentRunId];
}

async function profileFiles(root: string): Promise<string[]> {
	const folder = join(root, ".gori");
	const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (!entry) return [];
	if (!entry.isDirectory()) throw new DeploymentError("deployment_profile_invalid", ".gori must be a real directory", 409);
	return (await readdir(folder)).filter((file) => /^deploy-[a-zA-Z0-9._-]+\.md$/u.test(file)).sort();
}

async function loadProfile(root: string, file: string): Promise<{ profile: DeploymentProfile; path: string; hash: string }> {
	if (!/^deploy-[a-zA-Z0-9._-]+\.md$/u.test(file)) throw new DeploymentError("deployment_profile_invalid", "Invalid deployment profile file name");
	if (!(await lstat(join(root, ".gori"))).isDirectory())
		throw new DeploymentError("deployment_profile_invalid", ".gori must be a real directory", 409);
	const path = join(root, ".gori", file);
	const entry = await lstat(path);
	if (!entry.isFile()) throw new DeploymentError("deployment_profile_invalid", "Deployment profile must be a regular file");
	const source = await readFile(path, "utf8");
	return { profile: parseDeploymentProfile(source), path, hash: createHash("sha256").update(source).digest("hex") };
}

function inside(base: string, path: string): string {
	if (isAbsolute(path)) throw new DeploymentError("deployment_path_invalid", "Local deployment path must be relative");
	const resolved = resolve(base, path);
	if (!contained(base, resolved)) throw new DeploymentError("deployment_path_invalid", "Local deployment path escapes the project");
	return resolved;
}

function contained(base: string, path: string): boolean {
	const relation = relative(base, path);
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function validAgentRunId(value: string): boolean {
	return Boolean(value.trim()) && value === value.trim() && value.length <= 200 && !/[\0-\x1f]/u.test(value);
}

function discussionTarget(target: SshTargetSnapshot): DeploymentDiscussion["targetBinding"] {
	return {
		hostname: target.hostname, port: target.port, workspaceRevision: target.workspaceRevision,
		hostKeyAlgorithm: target.hostKeyAlgorithm, hostKeyFingerprint: target.hostKeyFingerprint,
		credentialId: target.credentialId, credentialAuthVersion: target.credentialAuthVersion,
		remoteUser: target.remoteUser, writableRoot: target.defaultCwd, sandboxWritableRoots: targetSandboxRoots(target),
	};
}

function sameDiscussionTarget(bound: DeploymentDiscussion["targetBinding"], target: SshTargetSnapshot): boolean {
	return bound.hostname === target.hostname && bound.port === target.port &&
		bound.workspaceRevision === target.workspaceRevision && bound.hostKeyAlgorithm === target.hostKeyAlgorithm &&
		bound.hostKeyFingerprint === target.hostKeyFingerprint && bound.credentialId === target.credentialId &&
		bound.credentialAuthVersion === target.credentialAuthVersion && bound.remoteUser === target.remoteUser &&
		bound.writableRoot === target.defaultCwd &&
		sameSandboxWritableRoots(bound.sandboxWritableRoots ?? defaultSandboxWritableRoots(bound.writableRoot), targetSandboxRoots(target));
}

function targetSandboxRoots(target: SshTargetSnapshot): string[] {
	return [...(target.sandboxWritableRoots ?? defaultSandboxWritableRoots(target.defaultCwd))];
}

function discussionConflict(): DeploymentError {
	return new DeploymentError("deployment_discussion_conflict", "Deployment discussion changed; start a new deployment discussion", 409);
}

function missing(): never { throw new DeploymentError("deployment_run_not_found", "Deployment run was not found", 404); }

function nextUpdatedAt(run: DeploymentRun): number { return Math.max(Date.now(), run.updatedAt + 1); }

function initialStages(now: number): DeploymentRun["stages"] {
	return {
		prepare: { status: "success", log: "", startedAt: now, finishedAt: now },
		build: { status: "pending", log: "" },
		upload: { status: "pending", log: "" },
		restart: { status: "pending", log: "" },
		verify: { status: "pending", log: "" },
	};
}

function encodeHistoryCursor(sessionId: string, run: DeploymentRun): string {
	return Buffer.from(JSON.stringify({ sessionId, effectiveAt: historyTime(run), id: run.id }), "utf8").toString("base64url");
}

function historyTime(run: DeploymentRun): number {
	return run.createdAt;
}

function decodeHistoryCursor(sessionId: string, cursor: string): DeploymentHistoryPosition {
	if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(cursor)) throw invalidHistoryCursor();
	const buffer = Buffer.from(cursor, "base64url");
	if (buffer.toString("base64url") !== cursor) throw invalidHistoryCursor();
	let value: unknown;
	try { value = JSON.parse(buffer.toString("utf8")); } catch { throw invalidHistoryCursor(); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidHistoryCursor();
	const position = value as Record<string, unknown>;
	if (Object.keys(position).length !== 3 || position.sessionId !== sessionId ||
		!Number.isSafeInteger(position.effectiveAt) || Number(position.effectiveAt) < 0 ||
		typeof position.id !== "string" || !position.id || position.id.length > 200) throw invalidHistoryCursor();
	return { effectiveAt: position.effectiveAt as number, id: position.id };
}

function invalidHistoryCursor(): DeploymentError {
	return new DeploymentError("deployment_request_invalid", "Deployment history cursor is invalid", 400);
}

async function runLocalBuild(command: string, cwd: string, signal: AbortSignal, log: (chunk: string) => void): Promise<void> {
	signal.throwIfAborted();
	const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
	let timedOut = false;
	let forceTimer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (!child.pid) return;
		try {
			if (process.platform === "win32") child.kill("SIGTERM");
			else process.kill(-child.pid, "SIGTERM");
		} catch { /* The process already exited. */ }
		forceTimer ??= setTimeout(() => {
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid!, "SIGKILL");
			} catch { /* The process already exited. */ }
		}, 5_000);
		forceTimer.unref();
	};
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => log(chunk.toString("utf8")));
	signal.addEventListener("abort", stop, { once: true });
	const timeout = setTimeout(() => { timedOut = true; stop(); }, 30 * 60_000);
	try {
		const exitCode = await new Promise<number>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolveExit(code ?? -1));
		});
		signal.throwIfAborted();
		if (timedOut) throw new DeploymentError("deployment_build_timeout", "Build exceeded the 30 minute limit", 409);
		if (exitCode !== 0) throw new DeploymentError("deployment_build_failed", `Build exited with status ${exitCode}`, 409);
	} finally {
		clearTimeout(timeout);
		// After cancellation the shell may exit before descendants that redirected
		// stdout/stderr. Keep the group-wide SIGKILL timer until it fires.
		signal.removeEventListener("abort", stop);
	}
}
