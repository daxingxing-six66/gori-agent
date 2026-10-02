import type { DatabaseSync } from "node:sqlite";
import type { DeploymentHistoryPosition, DeploymentRepository } from "../../application/repositories/deployment-repository.ts";
import { DEPLOY_STAGES, DeploymentError, type DeploymentRun, type DeploymentStageView } from "../../domain/deployment.ts";

const COLUMNS = "id, snapshot_json, status, session_id, workspace_id, created_at, updated_at";
// Match the Chat timeline: Agent claim time, legacy build start, then plan creation.
const HISTORY_TIME = `CASE WHEN json_valid(snapshot_json) THEN
	COALESCE(json_extract(snapshot_json, '$.startedAt'), json_extract(snapshot_json, '$.stages.build.startedAt'), created_at)
	ELSE created_at END`;
const HISTORY_ROWS = `WITH history AS (SELECT ${COLUMNS}, ${HISTORY_TIME} AS effective_at FROM deployment_runs WHERE session_id = ?)`;

export class SqliteDeploymentRepository implements DeploymentRepository {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) { this.database = database; }

	insert(run: DeploymentRun): void {
		this.database.prepare(`INSERT INTO deployment_runs
			(id, session_id, workspace_id, status, snapshot_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
			run.id, run.sessionId, run.workspaceId, run.status, JSON.stringify(run), run.createdAt, run.updatedAt,
		);
	}

	update(run: DeploymentRun): void {
		const result = this.database.prepare(`UPDATE deployment_runs SET status = ?, snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ?`).run(run.status, JSON.stringify(run), run.updatedAt, run.id, run.sessionId);
		if (result.changes !== 1) throw new DeploymentError("deployment_run_not_found", "Deployment run no longer exists", 404);
	}

	approvePreparing(run: DeploymentRun, expectedUpdatedAt: number): boolean {
		const result = this.database.prepare(`UPDATE deployment_runs SET snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ? AND status = 'preparing' AND updated_at = ?`).run(
			JSON.stringify(run), run.updatedAt, run.id, run.sessionId, expectedUpdatedAt,
		);
		return result.changes === 1;
	}

	claim(run: DeploymentRun): boolean {
		const result = this.database.prepare(`UPDATE deployment_runs SET status = 'running', snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ? AND status = 'preparing'
			AND NOT EXISTS (SELECT 1 FROM deployment_runs other WHERE other.workspace_id = ? AND other.status = 'running')`).run(
			JSON.stringify(run), run.updatedAt, run.id, run.sessionId, run.workspaceId,
		);
		return result.changes === 1;
	}

	cancelPreparing(run: DeploymentRun): boolean {
		const result = this.database.prepare(`UPDATE deployment_runs SET status = 'cancelled', snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ? AND status = 'preparing'`).run(
			JSON.stringify(run), run.updatedAt, run.id, run.sessionId,
		);
		return result.changes === 1;
	}

	find(sessionId: string, id: string): DeploymentRun | undefined {
		const row = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_runs WHERE id = ? AND session_id = ?`).get(id, sessionId);
		return row ? parseRow(row) : undefined;
	}

	latest(sessionId: string): DeploymentRun | undefined {
		const row = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(sessionId);
		return row ? parseRow(row) : undefined;
	}

	listRecent(sessionId: string, limit: number, before?: DeploymentHistoryPosition): DeploymentRun[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 51) throw new DeploymentError("deployment_request_invalid", "History page size is invalid", 400);
		const rows = before
			? this.database.prepare(`${HISTORY_ROWS} SELECT ${COLUMNS} FROM history WHERE
				(effective_at < ? OR (effective_at = ? AND id < ?)) ORDER BY effective_at DESC, id DESC LIMIT ?`).all(
					sessionId, before.effectiveAt, before.effectiveAt, before.id, limit,
				)
			: this.database.prepare(`${HISTORY_ROWS} SELECT ${COLUMNS} FROM history ORDER BY effective_at DESC, id DESC LIMIT ?`).all(sessionId, limit);
		return rows.map(parseRow);
	}

	recoverInterrupted(now: number): void {
		const rows = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_runs WHERE status IN ('preparing', 'running')`).all();
		for (const row of rows) {
			const run = parseRow(row);
			for (const approval of Object.values(run.fullAccessApprovals ?? {})) {
				if (approval?.status === "pending") { approval.status = "rejected"; approval.resolvedAt = now; }
			}
			if (run.status === "preparing") {
				run.status = "cancelled";
				run.error = "Deployment plan was invalidated by a backend restart. No deployment stages were started.";
			} else {
				const warning = "Deployment was interrupted by a backend restart. Inspect remote effects before retrying.";
				const stage = DEPLOY_STAGES.find((name) => run.stages[name].status === "running");
				if (stage) run.stages[stage] = { ...run.stages[stage], status: "failed", finishedAt: Math.max(now, run.stages[stage].startedAt ?? run.createdAt), error: warning };
				run.status = "failed";
				run.error = warning;
			}
			run.finishedAt = Math.max(now, run.startedAt ?? run.createdAt);
			run.updatedAt = Math.max(now, run.updatedAt + 1, run.finishedAt);
			this.update(run);
		}
	}
}

function parseRow(value: unknown): DeploymentRun {
	const row = record(value);
	const snapshot = row.snapshot_json;
	for (const key of ["id", "status", "session_id", "workspace_id"]) string(row[key]);
	if (typeof snapshot !== "string" || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at)) throw corrupt();
	const run = parseRun(snapshot);
	if (run.id !== row.id || run.status !== row.status || run.sessionId !== row.session_id || run.workspaceId !== row.workspace_id ||
		run.createdAt !== row.created_at || run.updatedAt !== row.updated_at) throw corrupt();
	return run;
}

function parseRun(source: string): DeploymentRun {
	let value: unknown;
	try { value = JSON.parse(source); } catch { throw corrupt(); }
	const run = record(value);
	validateRunIdentity(run);
	const plan = validatePlan(run);
	validateApprovals(run, plan);
	validateStages(run, plan);
	validateRunCompletion(run);
	return value as DeploymentRun;
}

function validateRunIdentity(run: Record<string, unknown>): void {
	string(run.id); string(run.sessionId); string(run.workspaceId);
	if (run.agentRunId !== undefined) {
		string(run.agentRunId);
		if (String(run.agentRunId).length > 200 || String(run.agentRunId) !== String(run.agentRunId).trim() || /[\0-\x1f]/u.test(String(run.agentRunId))) throw corrupt();
		if (run.status === "preparing") throw corrupt();
	}
	if (!["preparing", "running", "success", "failed", "cancelled"].includes(String(run.status)) ||
		!Number.isSafeInteger(run.createdAt) || !Number.isSafeInteger(run.updatedAt)) throw corrupt();
	if (run.startedAt !== undefined && (!Number.isSafeInteger(run.startedAt) || Number(run.startedAt) < Number(run.createdAt) || Number(run.startedAt) > Number(run.updatedAt))) throw corrupt();
	if ((run.agentRunId === undefined) !== (run.startedAt === undefined)) throw corrupt();
}

function validatePlan(run: Record<string, unknown>): Record<string, unknown> {
	const plan = record(run.plan);
	string(plan.profilePath); string(plan.profileHash); string(plan.project);
	// Deployment snapshots written before remoteAccess existed were always sandboxed.
	if (plan.remoteAccess === undefined) plan.remoteAccess = { mode: "workspace_write" };
	const remoteAccess = record(plan.remoteAccess);
	if (remoteAccess.mode !== "workspace_write" && remoteAccess.mode !== "full_access") throw corrupt();
	if (remoteAccess.mode === "full_access" &&
		remoteAccess.reason !== "sandbox_unavailable" && remoteAccess.reason !== "sandbox_partial_enforcement") throw corrupt();
	const target = record(plan.target);
	string(target.host);
	if (target.name !== undefined) string(target.name);
	const binding = record(plan.targetBinding);
	if (!Number.isSafeInteger(binding.port) || !Number.isSafeInteger(binding.credentialAuthVersion)) throw corrupt();
	if (binding.workspaceRevision !== undefined && !Number.isSafeInteger(binding.workspaceRevision)) throw corrupt();
	if (binding.hostKeyAlgorithm !== undefined) string(binding.hostKeyAlgorithm);
	for (const key of ["hostKeyFingerprint", "credentialId", "remoteUser", "writableRoot"]) string(binding[key]);
	const module = record(plan.module);
	string(module.id); string(module.name);
	const build = record(plan.build);
	string(build.cwd); string(build.command); string(build.artifact);
	const upload = record(plan.upload); string(upload.remotePath);
	const restart = record(plan.restart); string(restart.command);
	if (plan.verify !== undefined) string(record(plan.verify).command);
	return plan;
}

function validateApprovals(run: Record<string, unknown>, plan: Record<string, unknown>): void {
	const remoteAccess = record(plan.remoteAccess);
	if (remoteAccess.mode === "full_access") {
		const approvals = record(run.fullAccessApprovals);
		for (const stage of ["restart", ...(plan.verify === undefined ? [] : ["verify"])]) {
			const approval = record(approvals[stage]);
			string(approval.id);
			if (approval.stage !== stage || approval.command !== record(plan[stage]).command ||
				!["pending", "approved", "rejected"].includes(String(approval.status)) ||
				!Number.isSafeInteger(approval.requestedAt)) throw corrupt();
			if (approval.status === "pending" && (approval.resolvedAt !== undefined || approval.expiresAt !== undefined)) throw corrupt();
			if (approval.status === "approved" && (!Number.isSafeInteger(approval.resolvedAt) ||
				!Number.isSafeInteger(approval.expiresAt) || Number(approval.expiresAt) <= Number(approval.resolvedAt))) throw corrupt();
			if (approval.status === "rejected" && (!Number.isSafeInteger(approval.resolvedAt) || approval.expiresAt !== undefined)) throw corrupt();
		}
		if (Object.keys(approvals).some((stage) => stage !== "restart" && stage !== "verify") ||
			(plan.verify === undefined && approvals.verify !== undefined)) throw corrupt();
	} else if (run.fullAccessApprovals !== undefined) throw corrupt();
}

function validateStages(run: Record<string, unknown>, plan: Record<string, unknown>): void {
	const stages = record(run.stages) as Record<string, DeploymentStageView | undefined>;
	for (const stage of DEPLOY_STAGES) {
		const view = stages[stage];
		if (!view || !["pending", "running", "success", "failed", "skipped"].includes(view.status) || typeof view.log !== "string") throw corrupt();
		if (view.startedAt !== undefined && !Number.isSafeInteger(view.startedAt)) throw corrupt();
		if (view.finishedAt !== undefined && !Number.isSafeInteger(view.finishedAt)) throw corrupt();
		if (view.error !== undefined) string(view.error);
		if (view.progress && (!Number.isSafeInteger(view.progress.current) || !Number.isSafeInteger(view.progress.total))) throw corrupt();
		if (view.exitCode !== undefined && !Number.isSafeInteger(view.exitCode)) throw corrupt();
		if (view.failureCode !== undefined && (typeof view.failureCode !== "string" || !/^[a-z][a-z0-9_]{0,79}$/u.test(view.failureCode))) throw corrupt();
		if (view.operationId !== undefined && (typeof view.operationId !== "string" || !view.operationId.trim() || view.operationId.length > 200)) throw corrupt();
		if (view.safeDetails !== undefined) {
			const details = record(view.safeDetails);
			if (Object.keys(details).length > 32) throw corrupt();
			for (const [key, detail] of Object.entries(details)) {
				if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(key) ||
					!(typeof detail === "boolean" || (typeof detail === "number" && Number.isFinite(detail)) ||
						(typeof detail === "string" && detail.length <= 1_000))) throw corrupt();
			}
		}
	}
	validateStageSequence(String(run.status), stages, plan.verify !== undefined);
}

function validateRunCompletion(run: Record<string, unknown>): void {
	if (run.finishedAt !== undefined && !Number.isSafeInteger(run.finishedAt)) throw corrupt();
	if (run.agentRunId !== undefined &&
		((run.status === "running" && run.finishedAt !== undefined) ||
			(run.status !== "running" && (!Number.isSafeInteger(run.finishedAt) || Number(run.finishedAt) < Number(run.startedAt))))) throw corrupt();
	if (run.error !== undefined) string(run.error);
}

/** A completed prefix may be followed by one running/failed stage and pending successors. */
function validateStageSequence(status: string, stages: Record<string, DeploymentStageView | undefined>, hasVerify: boolean): void {
	if (stages.prepare?.status !== "success") throw corrupt();
	let tailStarted = false;
	let running = false;
	let failed = false;
	for (const stage of DEPLOY_STAGES.slice(1)) {
		const stageStatus = stages[stage]!.status;
		if (stageStatus === "skipped" && (stage !== "verify" || hasVerify)) throw corrupt();
		if (stageStatus === "success" || stageStatus === "skipped") {
			if (tailStarted || (stage === "verify" && !hasVerify && stageStatus !== "skipped")) throw corrupt();
			continue;
		}
		if ((stageStatus === "running" || stageStatus === "failed") && tailStarted) throw corrupt();
		if (stageStatus === "running") running = true;
		if (stageStatus === "failed") failed = true;
		tailStarted = true;
	}
	if (status === "preparing" && (running || failed || DEPLOY_STAGES.slice(1).some((stage) => stages[stage]!.status !== "pending"))) throw corrupt();
	if (status === "running" && failed) throw corrupt();
	if (status === "success" && tailStarted) throw corrupt();
	if ((status === "failed" || status === "cancelled") && running) throw corrupt();
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw corrupt();
	return value as Record<string, unknown>;
}

function string(value: unknown): void {
	if (typeof value !== "string" || !value.trim()) throw corrupt();
}

function corrupt(): DeploymentError {
	return new DeploymentError("deployment_data_corrupt", "Saved deployment run is invalid", 500);
}
