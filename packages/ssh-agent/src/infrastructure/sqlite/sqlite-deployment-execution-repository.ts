import type { DatabaseSync } from "node:sqlite";
import type { DeploymentExecutionRepository } from "../../application/repositories/deployment-execution-repository.ts";
import { DeploymentError, type DeploymentExecutableStage } from "../../domain/deployment.ts";
import type { DeploymentLogChunk, DeploymentLogPage, DeploymentStageExecution } from "../../domain/deployment-execution.ts";
import { validateStageView } from "./sqlite-deployment-repository.ts";

export class SqliteDeploymentExecutionRepository implements DeploymentExecutionRepository {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) { this.database = database; }

	findRequest(deploymentRunId: string, requestId: string): DeploymentStageExecution | undefined {
		const row = this.database.prepare(`SELECT * FROM deployment_stage_executions
			WHERE deployment_run_id = ? AND request_id = ?`).get(deploymentRunId, requestId);
		if (!row) return undefined;
		if (!id(row.id) || !id(row.agent_run_id) || !stage(row.stage) || !integer(row.plan_revision, 1) ||
			!integer(row.started_at) || !["running", "success", "failed", "skipped", "interrupted"].includes(String(row.status)) ||
			(row.status === "running" ? row.finished_at !== null : !integer(row.finished_at) || Number(row.finished_at) < Number(row.started_at))) throw corrupt();
		const execution: DeploymentStageExecution = {
			id: row.id, deploymentRunId, requestId, agentRunId: row.agent_run_id, stage: row.stage,
			planRevision: Number(row.plan_revision), status: row.status as DeploymentStageExecution["status"], startedAt: Number(row.started_at),
			...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
		};
		if (row.result_json !== null) {
			let result: unknown;
			try { result = JSON.parse(String(row.result_json)); } catch { throw corrupt(); }
			validateStageView(result);
			if (!result || typeof result !== "object" || !("status" in result) || result.status !== execution.status ||
				!("log" in result) || typeof result.log !== "string") throw corrupt();
			execution.result = result as NonNullable<DeploymentStageExecution["result"]>;
		}
		return execution;
	}

	insert(execution: DeploymentStageExecution): void {
		this.database.prepare(`INSERT INTO deployment_stage_executions
			(id, deployment_run_id, request_id, agent_run_id, stage, plan_revision, status, started_at)
			VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`).run(execution.id, execution.deploymentRunId, execution.requestId,
			execution.agentRunId, execution.stage, execution.planRevision, execution.startedAt);
	}

	finish(execution: DeploymentStageExecution): void {
		const result = this.database.prepare(`UPDATE deployment_stage_executions SET status = ?, finished_at = ?, result_json = ?
			WHERE id = ? AND deployment_run_id = ? AND status = 'running'`).run(execution.status, execution.finishedAt ?? null,
			execution.result === undefined ? null : JSON.stringify(execution.result), execution.id, execution.deploymentRunId);
		if (result.changes !== 1) throw new DeploymentError("deployment_execution_conflict", "Deployment execution was already settled", 409);
	}

	append(chunk: Omit<DeploymentLogChunk, "sequence">): DeploymentLogChunk {
		const row = this.database.prepare(`INSERT INTO deployment_logs
			(deployment_run_id, sequence, execution_id, stage, timestamp, kind, text)
			SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ? FROM deployment_logs WHERE deployment_run_id = ?
			HAVING EXISTS (SELECT 1 FROM deployment_stage_executions WHERE id = ? AND deployment_run_id = ? AND stage = ? AND status = 'running')
			RETURNING sequence`).get(chunk.deploymentRunId, chunk.executionId, chunk.stage, chunk.timestamp, chunk.kind, chunk.text, chunk.deploymentRunId,
			chunk.executionId, chunk.deploymentRunId, chunk.stage);
		if (!row || !integer(row.sequence, 1)) throw corrupt();
		return { ...chunk, sequence: Number(row.sequence) };
	}

	logs(deploymentRunId: string, requestedStage: DeploymentExecutableStage, afterSequence: number, limit: number): DeploymentLogPage {
		if (!stage(requestedStage) || !integer(afterSequence) || !integer(limit, 1) || limit > 500)
			throw new DeploymentError("deployment_request_invalid", "Expected a valid stage, cursor and log page size (1-500)", 400);
		const rows = this.database.prepare(`SELECT * FROM deployment_logs WHERE deployment_run_id = ? AND stage = ? AND sequence > ?
			ORDER BY sequence LIMIT ?`).all(deploymentRunId, requestedStage, afterSequence, limit + 1);
		const chunks = rows.slice(0, limit).map((row): DeploymentLogChunk => {
			if (!integer(row.sequence, 1) || !id(row.execution_id) || !integer(row.timestamp) || typeof row.text !== "string" ||
				!["boundary", "output", "result"].includes(String(row.kind))) throw corrupt();
			return { deploymentRunId, executionId: row.execution_id, stage: requestedStage, sequence: Number(row.sequence),
				timestamp: Number(row.timestamp), kind: row.kind as DeploymentLogChunk["kind"], text: row.text };
		});
		return { chunks, nextSequence: chunks.at(-1)?.sequence ?? afterSequence, hasMore: rows.length > limit };
	}

	recoverInterrupted(now: number): void {
		this.database.prepare(`UPDATE deployment_stage_executions SET status = 'interrupted', finished_at = MAX(started_at, ?)
			WHERE status = 'running'`).run(now);
	}
}

function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum; }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\0-\x1f]/u.test(value); }
function stage(value: unknown): value is DeploymentExecutableStage { return ["build", "upload", "restart", "verify"].includes(String(value)); }
function corrupt(): DeploymentError { return new DeploymentError("deployment_data_corrupt", "Saved deployment execution is invalid", 500); }
