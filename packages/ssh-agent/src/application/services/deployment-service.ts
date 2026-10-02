import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEPLOY_STAGES, DeploymentError, parseDeploymentProfile,
	type DeploymentPlan, type DeploymentProfile, type DeploymentRemoteStage, type DeploymentRun, type DeployStage,
} from "../../domain/deployment.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { WorkspaceRepository } from "../repositories/workspace-repository.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";
import type { CommandOperationService } from "./command-operation-service.ts";
import type { FileTransferService } from "./file-transfer-service.ts";
import type { DeploymentHistoryPosition, DeploymentRepository } from "../repositories/deployment-repository.ts";
import type { WorkspaceEventHub } from "../workspace-event-hub.ts";
import type { SessionLifecycleCoordinator, SessionUseLease } from "./session-lifecycle-coordinator.ts";
import type { RemoteSandboxProber } from "./remote-sandbox-provider.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { CommandOperation } from "../../domain/command-operation.ts";
import type { SshFailureCode, SshSafeDetail } from "../../domain/ssh-failure.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import { RemoteSandboxApprovalStore, type FullAccessRequest } from "./remote-sandbox-approval-store.ts";

const LOG_LIMIT = 128 * 1024;
const FULL_ACCESS_APPROVAL_TTL_MS = 5 * 60_000;
const SKILL_PATH = fileURLToPath(new URL("../../../resources/skills/gori-deployment-spec/SKILL.md", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../../../resources/skills/gori-deployment-spec/references/profile-schema.md", import.meta.url));

export interface DeploymentProfileSummary {
	file: string;
	project: string;
	target: DeploymentProfile["target"];
	modules: Pick<DeploymentProfile["modules"][number], "id" | "name">[];
}

type AgentDeployStage = Exclude<DeployStage, "prepare">;
const AGENT_STAGES: readonly AgentDeployStage[] = ["build", "upload", "restart", "verify"];

interface ActiveDeployment { stage: AgentDeployStage; controller: AbortController; task: Promise<DeploymentRun> }
interface ClaimedDeployment { lease?: SessionUseLease; sessionId: string; agentRunId: string }

interface DeploymentServiceOptions {
	sessions: SessionRepository;
	workspaces: WorkspaceRepository;
	targets: SshTargetResolver;
	commands: Pick<CommandOperationService, "submit" | "preflightGuard">;
	sandbox: RemoteSandboxProber;
	sandboxApprovals: RemoteSandboxApprovalStore;
	transfers: Pick<FileTransferService, "create" | "upload" | "get" | "listDirectory">;
	repository: DeploymentRepository;
	events: WorkspaceEventHub;
	localCwd: string;
	lifecycle?: SessionLifecycleCoordinator;
	cancelAgentRun?: (sessionId: string, agentRunId: string) => Promise<void>;
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
	private closing = false;
	private readonly options: DeploymentServiceOptions;

	constructor(options: DeploymentServiceOptions) {
		this.options = options;
	}

	async listProfiles(sessionId: string): Promise<{ host: string; profiles: DeploymentProfileSummary[]; errors: { file: string; message: string }[]; latest: DeploymentRun | null }> {
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
		return { host: context.host, profiles, errors, latest: this.options.repository.latest(sessionId) ?? null };
	}

	async setupInstructions(sessionId: string): Promise<string> {
		const { root, host } = await this.context(sessionId);
		const [skill, schema] = await Promise.all([readFile(SKILL_PATH, "utf8"), readFile(SCHEMA_PATH, "utf8")]);
		return `The user invoked /deploy and no usable deployment profile exists for this Workspace.\nCurrent local project root: ${root}\nCurrent Workspace SSH host: ${host}\nFollow this bundled Gori skill for this Run only:\n\n${skill}\n\nReferenced profile schema:\n\n${schema}`;
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
		// Fail before any local build or SFTP upload if constrained remote commands cannot start.
		const remoteAccess = await this.remoteAccessFor(target);
		await this.ensureRemoteDestination(context.workspaceId, target.defaultCwd, module.upload.target);
		for (const command of [module.restart.command, module.verify?.command]) {
			if (!command) continue;
			const decision = await this.options.commands.preflightGuard(sessionId, command);
			if (!decision.allowed) throw new DeploymentError("deployment_guard_blocked", decision.matchedRule?.reason ?? "Workspace Guard blocked a deployment command", 409);
		}
		const plan: DeploymentPlan = {
			profilePath: path,
			profileHash: hash,
			remoteAccess,
			project: profile.project,
			target: { ...profile.target },
			targetBinding: {
				workspaceRevision: target.workspaceRevision, port: target.port,
				hostKeyAlgorithm: target.hostKeyAlgorithm, hostKeyFingerprint: target.hostKeyFingerprint, credentialId: target.credentialId,
				credentialAuthVersion: target.credentialAuthVersion, remoteUser: target.remoteUser, writableRoot: target.defaultCwd,
			},
			module: { id: module.id, name: module.name },
			build: { cwd: cwdReal, command: module.build.command, artifact },
			upload: { remotePath: module.upload.target },
			restart: { command: module.restart.command },
			...(module.verify === undefined ? {} : { verify: { command: module.verify.command } }),
		};
		const now = Date.now();
		const run: DeploymentRun = {
			id: randomUUID(), sessionId, workspaceId: context.workspaceId, status: "preparing", plan,
			stages: initialStages(now),
			...(remoteAccess.mode === "full_access" ? { fullAccessApprovals: {
				restart: { id: randomUUID(), stage: "restart" as const, command: module.restart.command, status: "pending" as const, requestedAt: now },
				...(module.verify === undefined ? {} : { verify: { id: randomUUID(), stage: "verify" as const, command: module.verify.command, status: "pending" as const, requestedAt: now } }),
			} } : {}),
			createdAt: now, updatedAt: now,
		};
		this.options.repository.insert(run);
		this.publish(run);
		return run;
	}

	get(sessionId: string, id: string): DeploymentRun {
		return this.options.repository.find(sessionId, id) ?? missing();
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
		if (run.plan.remoteAccess.mode !== "full_access")
			throw new DeploymentError("deployment_approval_unavailable", "This deployment does not require Full Access", 409);
		const approval = run.fullAccessApprovals?.[stage];
		if (!approval || approval.id !== approvalId || approval.command !== run.plan[stage]?.command)
			throw new DeploymentError("deployment_approval_not_found", "Full Access approval does not match the deployment plan", 404);
		if (approval.status === "rejected" || (approval.status === "approved" && !approved)) {
			if (approval.status === "rejected" && !approved) return run;
			throw new DeploymentError("deployment_approval_conflict", "Full Access approval was already resolved", 409);
		}
		if (run.status !== "preparing")
			throw new DeploymentError("deployment_approval_conflict", "Deployment is no longer awaiting approval", 409);
		const now = Date.now();
		if (approval.status === "approved" && approved && (approval.expiresAt ?? 0) > now) return run;
		if (approved) {
			const expectedUpdatedAt = run.updatedAt;
			approval.status = "approved";
			approval.resolvedAt = now;
			approval.expiresAt = now + FULL_ACCESS_APPROVAL_TTL_MS;
			run.updatedAt = nextUpdatedAt(run);
			if (!this.options.repository.approvePreparing(run, expectedUpdatedAt))
				throw new DeploymentError("deployment_approval_conflict", "Deployment approval changed; reload the plan", 409);
		} else {
			approval.status = "rejected";
			approval.resolvedAt = now;
			delete approval.expiresAt;
			run.status = "cancelled";
			run.finishedAt = now;
			run.updatedAt = nextUpdatedAt(run);
			if (!this.options.repository.cancelPreparing(run))
				throw new DeploymentError("deployment_approval_conflict", "Deployment is no longer awaiting approval", 409);
		}
		this.publish(run);
		return run;
	}

	async claimForAgent(sessionId: string, id: string, agentRunId: string): Promise<DeploymentRun> {
		if (!agentRunId.trim() || agentRunId !== agentRunId.trim() || agentRunId.length > 200 || /[\0-\x1f]/u.test(agentRunId))
			throw new DeploymentError("deployment_agent_invalid", "Agent Run ID is invalid");
		if (this.closing) throw new DeploymentError("deployment_unavailable", "Deployment service is closing", 503);
		const run = this.get(sessionId, id);
		if (run.agentRunId === agentRunId) return run;
		if (run.status !== "preparing" || run.agentRunId !== undefined)
			throw new DeploymentError("deployment_agent_mismatch", "Deployment belongs to another Agent Run or is no longer awaiting confirmation", 409);
		this.requireFullAccessApprovals(run);
		const lease = this.options.lifecycle?.acquireUse(sessionId, "deployment_run");
		let leaseTransferred = false;
		try {
			await this.requireCurrentPlan(run);
			this.requireFullAccessApprovals(run);
			run.status = "running";
			run.agentRunId = agentRunId;
			run.startedAt = Math.max(Date.now(), run.createdAt);
			run.updatedAt = nextUpdatedAt(run);
			if (!this.options.repository.claim(run)) {
				const current = this.get(sessionId, id);
				if (current.agentRunId === agentRunId) return current;
				if (current.status === "preparing")
					throw new DeploymentError("deployment_workspace_busy", "Another deployment is running for this Workspace", 409);
				throw new DeploymentError("deployment_agent_mismatch", "Deployment was claimed or cancelled by another request", 409);
			}
			this.claimed.set(id, { lease, sessionId, agentRunId });
			leaseTransferred = true;
			if (run.plan.remoteAccess.mode === "full_access") {
				// Approval must be fresh when deployment starts. The exact one-use grants then
				// remain valid until their stage runs or this deployment ends.
				this.options.sandboxApprovals.approve(this.fullAccessRequest(run, "restart", run.plan.restart.command));
				if (run.plan.verify) this.options.sandboxApprovals.approve(this.fullAccessRequest(run, "verify", run.plan.verify.command));
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
			run.status = signal.aborted ? "cancelled" : "failed";
			run.error = error instanceof Error ? error.message : "Deployment failed";
			run.finishedAt = endedAt;
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
			const cwdNow = await realpath(run.plan.build.cwd);
			if (cwdNow !== run.plan.build.cwd) throw new DeploymentError("deployment_workdir_invalid", "Build workdir changed", 409);
			await runLocalBuild(run.plan.build.command, run.plan.build.cwd, signal, (line) => this.log(run, "build", line));
			const artifact = await realpath(run.plan.build.artifact);
			if (!contained(run.plan.build.cwd, artifact) || !(await stat(artifact)).isFile())
				throw new DeploymentError("deployment_artifact_invalid", "Build artifact must be a regular file inside the workdir", 409);
		});
	}

	private async upload(run: DeploymentRun, signal: AbortSignal): Promise<void> {
		await this.stage(run, "upload", signal, async () => {
			await this.requireCurrentPlan(run);
			await this.ensureRemoteDestination(run.workspaceId, run.plan.targetBinding.writableRoot, run.plan.upload.remotePath);
			const artifact = await realpath(run.plan.build.artifact);
			if (!contained(run.plan.build.cwd, artifact)) throw new DeploymentError("deployment_artifact_invalid", "Build artifact escaped the workdir", 409);
			const info = await stat(artifact);
			if (!info.isFile()) throw new DeploymentError("deployment_artifact_invalid", "Only regular file artifacts are supported", 409);
			const transfer = await this.options.transfers.create(run.workspaceId, {
				direction: "upload", remotePath: run.plan.upload.remotePath, totalBytes: info.size, overwrite: true,
			});
			this.assertBoundTarget(run, transfer.target);
			let polling = false;
			let stopped = false;
			const ticker = setInterval(() => {
				if (polling || stopped) return;
				polling = true;
				void this.options.transfers.get(run.workspaceId, transfer.id).then((current) => {
					if (stopped || run.status !== "running") return;
					run.stages.upload.progress = { current: current.bytesTransferred, total: current.totalBytes };
					this.save(run);
				}).catch(() => undefined).finally(() => { polling = false; });
			}, 300);
			try {
				const result = await this.options.transfers.upload(run.workspaceId, transfer.id, createReadStream(artifact), signal);
				if (result.status !== "completed")
					throw new DeploymentError("deployment_upload_failed", result.failure?.message ?? "Upload did not complete", 409);
				run.stages.upload.progress = { current: result.bytesTransferred, total: result.totalBytes };
				this.log(run, "upload", `Uploaded ${result.bytesTransferred} bytes to ${run.plan.upload.remotePath}\n`);
			} finally { stopped = true; clearInterval(ticker); }
		});
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
		const fullAccess = run.plan.remoteAccess.mode === "full_access"
			? this.fullAccessRequest(run, stage, command)
			: undefined;
		const result = await this.options.commands.submit({
			sessionId: run.sessionId,
			toolCallId: fullAccess?.toolCallId ?? `deploy:${run.id}:${stage}`,
			command,
			sandboxPermissions: fullAccess ? "full_access" : "workspace_write",
			...(fullAccess ? { fullAccessApprovalScopeId: fullAccess.agentRunId, justification: fullAccess.justification } : {}),
			expectedTarget,
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
		return target;
	}

	/** Recheck the reviewed plan before each side effect; Agent tools can modify project files between stages. */
	private async requireCurrentPlan(run: DeploymentRun): Promise<void> {
		const context = await this.context(run.sessionId);
		if (context.workspaceId !== run.workspaceId || context.host !== run.plan.target.host)
			throw new DeploymentError("deployment_target_mismatch", "Workspace target changed before deployment", 409);
		await this.requireBoundTarget(run);
		const cwdNow = await realpath(run.plan.build.cwd);
		if (!contained(context.root, cwdNow) || cwdNow !== run.plan.build.cwd)
			throw new DeploymentError("deployment_workdir_invalid", "Build workdir changed; review a new plan", 409);
		const { hash, profile, path } = await loadProfile(context.root, run.plan.profilePath.split(sep).at(-1) ?? "");
		const module = profile.modules.find(({ id }) => id === run.plan.module.id);
		if (path !== run.plan.profilePath || hash !== run.plan.profileHash || !module ||
			profile.project !== run.plan.project || profile.target.host !== run.plan.target.host ||
			module.name !== run.plan.module.name || module.build.command !== run.plan.build.command ||
			module.upload.target !== run.plan.upload.remotePath || module.restart.command !== run.plan.restart.command ||
			(module.verify?.command ?? null) !== (run.plan.verify?.command ?? null) ||
			await realpath(inside(context.root, module.workdir)) !== run.plan.build.cwd ||
			inside(run.plan.build.cwd, module.build.artifact) !== run.plan.build.artifact)
			throw new DeploymentError("deployment_profile_changed", "Deployment profile changed; review a new plan", 409);
	}

	private async remoteAccessFor(target: SshTargetSnapshot): Promise<DeploymentPlan["remoteAccess"]> {
		try {
			await this.options.sandbox.probe(target, AbortSignal.timeout(30_000));
			return { mode: "workspace_write" };
		} catch (error) {
			if (error instanceof SshAgentError &&
				(error.failure.code === "sandbox_unavailable" || error.failure.code === "sandbox_partial_enforcement"))
				return { mode: "full_access", reason: error.failure.code };
			throw error;
		}
	}

	private requireFullAccessApprovals(run: DeploymentRun): void {
		if (run.plan.remoteAccess.mode !== "full_access") return;
		const now = Date.now();
		const stages: ("restart" | "verify")[] = run.plan.verify ? ["restart", "verify"] : ["restart"];
		for (const stage of stages) {
			const approval = run.fullAccessApprovals?.[stage];
			if (!approval || approval.status !== "approved" || approval.command !== run.plan[stage]?.command ||
				(approval.expiresAt ?? 0) <= now)
				throw new DeploymentError("deployment_full_access_approval_required", "Approve each Full Access remote command before starting deployment", 409);
		}
	}

	private fullAccessRequest(run: DeploymentRun, stage: "restart" | "verify", command: string): FullAccessRequest {
		return {
			agentRunId: `deployment:${run.id}`,
			toolCallId: `deploy:${run.id}:${stage}`,
			sessionId: run.sessionId,
			command,
			justification: `User approved unsandboxed /deploy ${stage} after remote sandbox capability was unavailable`,
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

	private async stage(run: DeploymentRun, name: AgentDeployStage, signal: AbortSignal, action: () => Promise<void>, finalStatus: "success" | "skipped" = "success"): Promise<void> {
		run.stages[name] = { status: "running", log: "", startedAt: Math.max(Date.now(), run.startedAt ?? run.createdAt) };
		this.save(run);
		try {
			signal.throwIfAborted();
			await action();
			signal.throwIfAborted();
			run.stages[name].status = finalStatus;
			run.stages[name].finishedAt = Math.max(Date.now(), run.stages[name].startedAt ?? run.createdAt);
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
			// The caller persists the stage and Run terminal states together. A
			// running Run with a failed stage is an invalid intermediate snapshot.
			throw error;
		}
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
	return run.startedAt ?? run.stages.build.startedAt ?? run.createdAt;
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
		if (forceTimer) clearTimeout(forceTimer);
		signal.removeEventListener("abort", stop);
	}
}
