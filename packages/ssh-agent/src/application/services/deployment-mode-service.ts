import { DeploymentError, type DeploymentDiscussion, type DeploymentRun } from "../../domain/deployment.ts";
import { deploymentModeView, type DeploymentModeView, type DeploymentOutcome } from "../../domain/deployment-session.ts";
import type { DeploymentDiscussionRepository } from "../repositories/deployment-discussion-repository.ts";
import type { DeploymentRepository } from "../repositories/deployment-repository.ts";
import type { DeploymentSessionRepository } from "../repositories/deployment-session-repository.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import { deploymentInputError, deploymentObject, deploymentText } from "../deployment-validation.ts";
import type { WorkspaceEventHub } from "../workspace-event-hub.ts";

interface FinishRequest { outcome: DeploymentOutcome; reason?: string }

/** Owns the durable mode boundary, independent of an individual Chat Run. */
export class DeploymentModeService {
	private readonly options: {
		sessions: DeploymentSessionRepository;
		discussions: DeploymentDiscussionRepository;
		runs: DeploymentRepository;
		transactions: TransactionRunner;
		events: WorkspaceEventHub;
	};
	private readonly finishing = new Map<string, Promise<DeploymentModeView>>();
	// Retained after a failed commit. A retry settles the same request, never replays work.
	private readonly pending = new Map<string, FinishRequest>();

	constructor(options: DeploymentModeService["options"]) { this.options = options; }

	active(sessionId: string): DeploymentModeView | null {
		const deployment = this.options.sessions.active(sessionId);
		return deployment ? this.get(sessionId, deployment.id) : null;
	}

	manages(sessionId: string, id: string): boolean { return this.options.sessions.find(sessionId, id) !== undefined; }
	hasPendingFinish(id: string): boolean { return this.pending.has(id); }

	get(sessionId: string, id: string): DeploymentModeView {
		const deployment = this.options.sessions.find(sessionId, id);
		if (!deployment) throw new DeploymentError("deployment_session_not_found", "Deployment was not found", 404);
		const discussion = this.options.discussions.find(sessionId, id);
		const run = discussion?.deploymentRunId ? this.options.runs.find(sessionId, discussion.deploymentRunId) ?? null : null;
		return deploymentModeView(deployment, run);
	}

	/** The caller's transaction also creates the Discussion and formal history message. */
	enter(discussion: DeploymentDiscussion): void {
		if (this.options.sessions.active(discussion.sessionId))
			throw new DeploymentError("deployment_session_busy", "Exit the current deployment before starting another", 409);
		this.options.sessions.insert({ id: discussion.id, sessionId: discussion.sessionId, workspaceId: discussion.workspaceId,
			title: discussion.module.name, createdAt: discussion.createdAt });
	}

	assertActive(sessionId: string, id: string): void {
		if (this.pending.has(id) || this.active(sessionId)?.deployment.id !== id)
			throw new DeploymentError("deployment_mode_inactive", "Deployment mode ended or is being settled", 409);
	}

	publishStarted(sessionId: string, id: string): void {
		const view = this.get(sessionId, id);
		const message = this.options.sessions.historyMessage(sessionId, id);
		if (message) this.options.events.publish(view.deployment.workspaceId, { type: "deployment.message.created", data: { sessionId, message } });
		this.options.events.publish(view.deployment.workspaceId, { type: "deployment.started", data: view });
	}

	finish(sessionId: string, id: string, request: FinishRequest,
		settleWork: () => Promise<DeploymentRun | null>): Promise<DeploymentModeView> {
		const current = this.get(sessionId, id);
		if (current.deployment.outcome) return Promise.resolve(current);
		const existing = this.finishing.get(id);
		if (existing) return existing;
		validateFinish(request);
		const retained = this.pending.get(id) ?? request;
		if (retained.outcome === "success" && (!current.run || !["build", "upload", "restart", "verify"].every((stage) =>
			["success", "skipped"].includes(current.run!.stages[stage as keyof DeploymentRun["stages"]].status))))
			throw new DeploymentError("deployment_incomplete", `Cannot finish successfully; incomplete stages: ${current.run ? Object.entries(current.run.stages).filter(([, value]) => !["success", "skipped"].includes(value.status)).map(([stage, value]) => `${stage}=${value.status}`).join(", ") : "no confirmed plan"}`, 409, { field: "outcome" });
		this.pending.set(id, retained);
		const task = Promise.resolve().then(async () => {
			const settled = await settleWork();
			await this.options.transactions.run(() => {
				const latest = this.get(sessionId, id);
				if (latest.deployment.outcome) return;
				const now = Math.max(Date.now(), latest.deployment.createdAt);
				const run = settled ?? latest.run;
				if (run) {
					run.status = retained.outcome;
					run.finishedAt = Math.max(now, run.startedAt ?? run.createdAt);
					run.updatedAt = Math.max(run.updatedAt + 1, run.finishedAt);
					if (retained.reason) run.error = retained.reason;
					else delete run.error;
					this.options.runs.update(run);
				}
				const discussion = this.options.discussions.find(sessionId, id);
				if (discussion?.status === "discussing" && !this.options.discussions.updateDiscussing({ ...discussion,
					status: "cancelled", revision: discussion.revision + 1, updatedAt: Math.max(now, discussion.updatedAt + 1) }, discussion.revision))
					throw new DeploymentError("deployment_discussion_conflict", "Deployment changed during settlement", 409);
				if (!this.options.sessions.finish(sessionId, id, retained.outcome, retained.reason, now))
					throw new DeploymentError("deployment_finish_conflict", "Deployment changed during settlement", 409);
			});
			const final = this.get(sessionId, id);
			this.pending.delete(id);
			this.options.events.publish(final.deployment.workspaceId, { type: "deployment.finished", data: final });
			return final;
		}).finally(() => { if (this.finishing.get(id) === task) this.finishing.delete(id); });
		this.finishing.set(id, task);
		return task;
	}
}

function validateFinish(request: FinishRequest): void {
	const code = "deployment_request_invalid";
	deploymentObject(request, "request", ["outcome", "reason"], code);
	if (!["success", "failed", "cancelled"].includes(request.outcome))
		deploymentInputError(code, "outcome", "must be success, failed or cancelled");
	if (request.outcome === "failed" || request.reason !== undefined)
		deploymentText(request.reason, "reason", 4_000, code);
}
