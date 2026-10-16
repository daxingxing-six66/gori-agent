import { DeploymentError, type DeploymentRun, type DeploymentExecutableStage } from "../../domain/deployment.ts";
import type { DeploymentLogChunk, DeploymentStageExecution } from "../../domain/deployment-execution.ts";
import type { DeploymentExecutionRepository } from "../repositories/deployment-execution-repository.ts";
import type { DeploymentRepository } from "../repositories/deployment-repository.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import type { WorkspaceEventHub } from "../workspace-event-hub.ts";

interface ExecutionCommit { run: DeploymentRun; execution: DeploymentStageExecution }

/** Durable execution identity and logs, without owning command or model orchestration. */
export class DeploymentExecutionRecorder {
	private readonly options: { executions: DeploymentExecutionRepository; runs: DeploymentRepository;
		transactions: TransactionRunner; events: WorkspaceEventHub };
	private readonly pending = new Map<string, ExecutionCommit>();
	private readonly committing = new Map<string, Promise<void>>();
	constructor(options: DeploymentExecutionRecorder["options"]) { this.options = options; }

	async begin(run: DeploymentRun, execution: DeploymentStageExecution, persistRun?: () => boolean): Promise<void> {
		await this.options.transactions.run(() => {
			if (persistRun && !persistRun()) throw new DeploymentError("deployment_workspace_busy", "Another deployment is running or the plan changed", 409);
			this.options.executions.insert(execution);
			if (!persistRun) this.options.runs.update(run);
		});
		this.publish(run, execution.stage);
	}

	async finish(run: DeploymentRun, execution: DeploymentStageExecution): Promise<void> {
		const result = structuredClone(run.stages[execution.stage]);
		const commit: ExecutionCommit = { run: structuredClone(run), execution: {
			...execution, status: result.status === "success" || result.status === "skipped" ? result.status : "failed",
			finishedAt: result.finishedAt ?? Math.max(Date.now(), execution.startedAt), result,
		} };
		this.pending.set(run.id, commit);
		await this.commit(commit);
	}

	async reconcile(deploymentRunId: string): Promise<void> {
		const pending = this.pending.get(deploymentRunId);
		if (pending) await this.commit(pending);
	}

	append(run: DeploymentRun, stage: DeploymentExecutableStage, executionId: string, text: string,
		kind: DeploymentLogChunk["kind"] = "output"): void {
		// Limit individual event size, without dropping the durable log history.
		for (let offset = 0; offset < text.length; offset += 16_384) {
			const chunk = this.options.executions.append({ deploymentRunId: run.id, stage, executionId, text: text.slice(offset, offset + 16_384),
				kind, timestamp: Date.now() });
			const view = run.stages[stage];
			const combined = view.log + chunk.text;
			view.log = combined.slice(-128 * 1024);
			view.logTruncated = view.logTruncated || combined.length > view.log.length;
			view.logCursor = chunk.sequence;
			this.options.events.publish(run.workspaceId, { type: "deployment.log.appended", data: { sessionId: run.sessionId, ...chunk } });
		}
	}

	private commit(commit: ExecutionCommit): Promise<void> {
		const existing = this.committing.get(commit.run.id);
		if (existing) return existing;
		const task = this.persist(commit).finally(() => {
			if (this.committing.get(commit.run.id) === task) this.committing.delete(commit.run.id);
		});
		this.committing.set(commit.run.id, task);
		return task;
	}

	private async persist(commit: ExecutionCommit): Promise<void> {
		await this.options.transactions.run(() => {
			this.options.executions.finish(commit.execution);
			this.options.runs.update(commit.run);
		});
		if (this.pending.get(commit.run.id) === commit) this.pending.delete(commit.run.id);
		this.publish(commit.run, commit.execution.stage);
	}

	private publish(run: DeploymentRun, stage: DeploymentExecutableStage): void {
		this.options.events.publish(run.workspaceId, { type: "deployment.stage.updated", data: { sessionId: run.sessionId,
			deploymentRunId: run.id, stage, revision: run.updatedAt, view: run.stages[stage] } });
		this.options.events.publish(run.workspaceId, { type: "deployment.updated", data: run });
	}
}
