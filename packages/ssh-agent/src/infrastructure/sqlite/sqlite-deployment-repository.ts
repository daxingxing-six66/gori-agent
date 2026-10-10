import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { isAbsolute, normalize, posix } from "node:path";
import type { DeploymentHistoryPosition, DeploymentRepository } from "../../application/repositories/deployment-repository.ts";
import { DEPLOY_STAGES, DeploymentError, type DeploymentRun, type DeploymentStageView } from "../../domain/deployment.ts";

const COLUMNS = "id, snapshot_json, status, session_id, workspace_id, created_at, updated_at";
// A mutable stage timestamp would move a run across a keyset cursor when the
// user confirms it between page requests. Keep its history position fixed.
const HISTORY_TIME = "created_at";
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

	updateRecovering(run: DeploymentRun, expectedUpdatedAt: number): boolean {
		const result = this.database.prepare(`UPDATE deployment_runs SET snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ? AND status = 'recovering' AND updated_at = ?`).run(
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

	claimRecovering(run: DeploymentRun, expectedUpdatedAt: number): boolean {
		const result = this.database.prepare(`UPDATE deployment_runs SET status = 'running', snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ? AND status = 'recovering' AND updated_at = ?
			AND NOT EXISTS (SELECT 1 FROM deployment_runs other WHERE other.workspace_id = ? AND other.status = 'running')`).run(
			JSON.stringify(run), run.updatedAt, run.id, run.sessionId, expectedUpdatedAt, run.workspaceId,
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

	cancelRecovering(run: DeploymentRun, expectedUpdatedAt: number): boolean {
		const result = this.database.prepare(`UPDATE deployment_runs SET status = 'cancelled', snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ? AND status = 'recovering' AND updated_at = ?`).run(
			JSON.stringify(run), run.updatedAt, run.id, run.sessionId, expectedUpdatedAt,
		);
		return result.changes === 1;
	}

	find(sessionId: string, id: string): DeploymentRun | undefined {
		const row = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_runs WHERE id = ? AND session_id = ?`).get(id, sessionId);
		return row ? parseRow(row) : undefined;
	}

	findByPlanningAgentRunId(sessionId: string, agentRunId: string): DeploymentRun | undefined {
		const row = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_runs WHERE session_id = ?
			AND json_extract(snapshot_json, '$.planningAgentRunId') = ?
			ORDER BY created_at DESC, id DESC LIMIT 1`).get(sessionId, agentRunId);
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
		const rows = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_runs WHERE status IN ('preparing', 'running', 'recovering')`).all();
		for (const row of rows) {
			const run = parseRow(row);
			if (run.status === "recovering") {
				// A saved approval is an audit fact, not a new process's one-use grant.
				// Require another explicit decision for every unfinished remote command.
				if (run.fullAccessApprovals) {
					let changed = false;
					for (const stage of ["restart", "verify"] as const) {
						const command = run.plan[stage]?.command;
						const approval = run.fullAccessApprovals?.[stage];
						if (!command || !approval || run.stages[stage].status === "success" || approval.status !== "approved") continue;
						run.fullAccessApprovals![stage] = { id: randomUUID(), stage, command, status: "pending", requestedAt: now,
							...(approval.toolName ? { toolName: approval.toolName } : {}), ...(approval.reason ? { reason: approval.reason } : {}) };
						changed = true;
					}
					if (changed) { run.updatedAt = Math.max(now, run.updatedAt + 1); this.update(run); }
				}
				continue;
			}
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
	validateRecovery(run, plan);
	validateRunCompletion(run);
	return value as DeploymentRun;
}

function validateRunIdentity(run: Record<string, unknown>): void {
	string(run.id); string(run.sessionId); string(run.workspaceId);
	if (run.discussionId !== undefined) {
		string(run.discussionId);
		if (String(run.discussionId).length > 200 || String(run.discussionId) !== String(run.discussionId).trim() ||
			/[\0-\x1f]/u.test(String(run.discussionId)) || run.planningAgentRunId === undefined) throw corrupt();
	}
	if (run.planningAgentRunId !== undefined) {
		string(run.planningAgentRunId);
		if (String(run.planningAgentRunId).length > 200 || String(run.planningAgentRunId) !== String(run.planningAgentRunId).trim() ||
			/[\0-\x1f]/u.test(String(run.planningAgentRunId))) throw corrupt();
	}
	if (run.planningProposalHash !== undefined &&
		(run.planningAgentRunId === undefined || typeof run.planningProposalHash !== "string" || !/^[a-f0-9]{64}$/u.test(run.planningProposalHash))) throw corrupt();
	if (run.agentRunId !== undefined) {
		string(run.agentRunId);
		if (String(run.agentRunId).length > 200 || String(run.agentRunId) !== String(run.agentRunId).trim() || /[\0-\x1f]/u.test(String(run.agentRunId))) throw corrupt();
		if (run.status === "preparing") throw corrupt();
	}
	if (run.agentRunHistory !== undefined) {
		if (!Array.isArray(run.agentRunHistory) || run.agentRunHistory.length > 128 ||
			run.agentRunHistory.some((id) => typeof id !== "string" || !id.trim() || id.length > 200 || /[\0-\x1f]/u.test(id)) ||
			new Set(run.agentRunHistory).size !== run.agentRunHistory.length ||
			(run.agentRunId !== undefined && !run.agentRunHistory.includes(run.agentRunId))) throw corrupt();
	}
	if (!["preparing", "running", "recovering", "success", "failed", "cancelled"].includes(String(run.status)) ||
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
	validateRemoteAccess(remoteAccess);
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
	if (plan.version === 2) {
		if (plan.build !== undefined || plan.upload !== undefined || !Array.isArray(plan.buildSteps) || !Array.isArray(plan.artifacts) ||
			plan.buildSteps.length < 1 || plan.buildSteps.length > 8 || plan.artifacts.length < 1 || plan.artifacts.length > 16) throw corrupt();
		for (const value of plan.buildSteps) {
			const step = record(value);
			if (!exactKeys(step, ["cwd", "command"])) throw corrupt();
			localPath(step.cwd); command(step.command);
		}
		const destinations = new Set<string>();
		for (const value of plan.artifacts) {
			const artifact = record(value);
			if (!exactKeys(artifact, ["source", "remotePath"])) throw corrupt();
			localPath(artifact.source); remoteFile(artifact.remotePath);
			if (destinations.has(artifact.remotePath as string)) throw corrupt();
			destinations.add(artifact.remotePath as string);
		}
	} else if (plan.version === undefined) {
		if (plan.buildSteps !== undefined || plan.artifacts !== undefined || run.planningAgentRunId !== undefined) throw corrupt();
		const build = record(plan.build);
		string(build.cwd); string(build.command); string(build.artifact);
		const upload = record(plan.upload); string(upload.remotePath);
	} else throw corrupt();
	const restart = record(plan.restart); string(restart.command);
	const verify = plan.verify === undefined ? undefined : record(plan.verify);
	if (verify) string(verify.command);
	if (plan.version === 2) {
		command(restart.command);
		if (verify) command(verify.command);
	}
	for (const remoteCommand of [restart, verify]) {
		if (!remoteCommand) continue;
		if (Object.keys(remoteCommand).some((key) => key !== "command" && key !== "writePaths" && key !== "access")) throw corrupt();
		if (remoteCommand.writePaths !== undefined) {
			if (!Array.isArray(remoteCommand.writePaths) || remoteCommand.writePaths.length < 1 || remoteCommand.writePaths.length > 16) throw corrupt();
			for (const path of remoteCommand.writePaths) remoteWritePath(path);
			if (new Set(remoteCommand.writePaths).size !== remoteCommand.writePaths.length) throw corrupt();
		}
		if (remoteCommand.access !== undefined) validateRemoteAccess(record(remoteCommand.access));
	}
	if (restart.access !== undefined || verify?.access !== undefined) {
		if (restart.access === undefined || (verify && verify.access === undefined)) throw corrupt();
		const full = [restart.access, verify?.access].find((access) => access && record(access).mode === "full_access");
		if (JSON.stringify(remoteAccess) !== JSON.stringify(full ?? { mode: "workspace_write" })) throw corrupt();
	}
	return plan;
}

function validateRemoteAccess(access: Record<string, unknown>): void {
	if (access.mode !== "workspace_write" && access.mode !== "full_access") throw corrupt();
	if (access.mode === "workspace_write" ? Object.keys(access).length !== 1
		: !["deployment_policy", "sandbox_unavailable", "sandbox_partial_enforcement", "sandbox_scope_exceeded", "session_sandbox_disabled"].includes(String(access.reason)) ||
			Object.keys(access).length !== 2) throw corrupt();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function command(value: unknown): void {
	if (typeof value !== "string" || !value.trim() || value.length > 4000 || /[\0-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw corrupt();
}

function localPath(value: unknown): void {
	if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\0-\x1f]/u.test(value) ||
		!isAbsolute(value) || normalize(value) !== value) throw corrupt();
}

function remoteFile(value: unknown): void {
	if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\0-\x1f]/u.test(value) ||
		!posix.isAbsolute(value) || value === "/" || value.endsWith("/") || posix.normalize(value) !== value) throw corrupt();
}

function remoteWritePath(value: unknown): void {
	if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") ||
		(value !== "/" && value.endsWith("/")) || posix.normalize(value) !== value || /[\0-\x1f]/u.test(value)) throw corrupt();
}

function validateApprovals(run: Record<string, unknown>, plan: Record<string, unknown>): void {
	const remoteStages = ["restart", ...(plan.verify === undefined ? [] : ["verify"])];
	const fullStages = remoteStages.filter((stage) => {
		const access = remoteStageAccess(plan, stage);
		return access.mode === "full_access" && access.reason !== "session_sandbox_disabled";
	});
	if (fullStages.length > 0) {
		const approvals = record(run.fullAccessApprovals);
		for (const stage of fullStages) {
			const approval = record(approvals[stage]);
			string(approval.id);
			if (approval.stage !== stage || approval.command !== record(plan[stage]).command ||
				!["pending", "approved", "rejected"].includes(String(approval.status)) ||
				!Number.isSafeInteger(approval.requestedAt)) throw corrupt();
			if (approval.status === "pending" && (approval.resolvedAt !== undefined || approval.expiresAt !== undefined)) throw corrupt();
			if (approval.status === "approved" && (!Number.isSafeInteger(approval.resolvedAt) ||
				!Number.isSafeInteger(approval.expiresAt) || Number(approval.expiresAt) <= Number(approval.resolvedAt))) throw corrupt();
			if (approval.status === "rejected" && (!Number.isSafeInteger(approval.resolvedAt) || approval.expiresAt !== undefined)) throw corrupt();
			if (approval.toolName !== undefined && approval.toolName !== "remote_sandbox_exception") throw corrupt();
			if (approval.reason !== undefined && approval.reason !== remoteStageAccess(plan, stage).reason) throw corrupt();
			const explicitAccess = record(plan[stage]).access;
			if (explicitAccess !== undefined && record(explicitAccess).reason !== "deployment_policy" &&
				(approval.toolName !== "remote_sandbox_exception" || approval.reason !== record(explicitAccess).reason)) throw corrupt();
		}
		if (Object.keys(approvals).some((stage) => stage !== "restart" && stage !== "verify") ||
			(plan.verify === undefined && approvals.verify !== undefined) ||
			remoteStages.some((stage) => !fullStages.includes(stage) && approvals[stage] !== undefined)) throw corrupt();
	} else if (run.fullAccessApprovals !== undefined) throw corrupt();
}

function remoteStageAccess(plan: Record<string, unknown>, stage: string): Record<string, unknown> {
	return record(plan[stage]).access === undefined ? record(plan.remoteAccess) : record(record(plan[stage]).access);
}

function validateStages(run: Record<string, unknown>, plan: Record<string, unknown>): void {
	const saved = record(run.stages);
	const stages: Record<string, DeploymentStageView | undefined> = {};
	for (const stage of DEPLOY_STAGES) {
		const view = saved[stage];
		validateStageView(view);
		stages[stage] = view;
	}
	validateStageSequence(String(run.status), stages, plan.verify !== undefined);
}

function validateStageView(value: unknown): asserts value is DeploymentStageView {
	const view = record(value);
	if (!["pending", "running", "success", "failed", "skipped"].includes(String(view.status)) || typeof view.log !== "string") throw corrupt();
	if (view.startedAt !== undefined && !Number.isSafeInteger(view.startedAt)) throw corrupt();
	if (view.finishedAt !== undefined && !Number.isSafeInteger(view.finishedAt)) throw corrupt();
	if (view.error !== undefined) string(view.error);
	if (view.progress !== undefined) {
		const progress = record(view.progress);
		if (!Number.isSafeInteger(progress.current) || !Number.isSafeInteger(progress.total)) throw corrupt();
	}
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

function validateRecovery(run: Record<string, unknown>, plan: Record<string, unknown>): void {
	if (run.planRevision !== undefined && (!Number.isSafeInteger(run.planRevision) || Number(run.planRevision) < 1)) throw corrupt();
	if (run.status === "recovering" && (plan.version !== 2 || run.agentRunId === undefined || run.finishedAt !== undefined)) throw corrupt();
	if (run.initialPlan !== undefined) {
		if (plan.version !== 2 || run.planRevision === undefined || Number(run.planRevision) < 1) throw corrupt();
		const initial = validatePlan({ plan: run.initialPlan });
		if (initial.version !== 2 || !samePlanIdentity(initial, plan)) throw corrupt();
	}
	const recoveries = run.recoveries;
	if (recoveries !== undefined) {
		if (plan.version !== 2 || run.initialPlan === undefined || !Array.isArray(recoveries) || recoveries.length < 1 || recoveries.length > 64) throw corrupt();
		let revision = 1;
		let previous = record(run.initialPlan);
		for (const [index, value] of recoveries.entries()) {
			const recovery = record(value);
			string(recovery.id); string(recovery.reason); string(recovery.agentRunId);
			if (String(recovery.reason).length > 1_000 || !["build", "upload", "restart", "verify"].includes(String(recovery.stage)) ||
				!["pending", "approved", "rejected"].includes(String(recovery.status)) ||
				!Number.isSafeInteger(recovery.baseRevision) || recovery.baseRevision !== revision ||
				!Number.isSafeInteger(recovery.proposedAt) ||
				(recovery.status === "pending" ? recovery.resolvedAt !== undefined || index !== recoveries.length - 1
					: !Number.isSafeInteger(recovery.resolvedAt) || Number(recovery.resolvedAt) < Number(recovery.proposedAt))) throw corrupt();
			const proposed = validatePlan({ plan: recovery.plan });
			if (proposed.version !== 2 || !samePlanIdentity(previous, proposed) ||
				!onlyStageChanged(previous, proposed, String(recovery.stage))) throw corrupt();
			if (recovery.status === "approved") { revision++; previous = proposed; }
		}
		if (run.planRevision !== revision || JSON.stringify(previous) !== JSON.stringify(plan)) throw corrupt();
	} else if (run.initialPlan !== undefined || (run.planRevision !== undefined && run.planRevision !== 1)) throw corrupt();
	const attempts = run.stageAttempts;
	if (attempts !== undefined) {
		const map = record(attempts);
		if (Object.keys(map).some((stage) => !["build", "upload", "restart", "verify"].includes(stage))) throw corrupt();
		for (const value of Object.values(map)) {
			if (!Array.isArray(value) || value.length > 64) throw corrupt();
			for (const entry of value) {
				const attempt = record(entry);
				string(attempt.agentRunId);
				if (!Number.isSafeInteger(attempt.planRevision) || Number(attempt.planRevision) < 1 ||
					Number(attempt.planRevision) > Number(run.planRevision ?? 1)) throw corrupt();
				const result = attempt.result;
				validateStageView(result);
				if (!["success", "failed", "skipped"].includes(result.status)) throw corrupt();
			}
		}
	}
}

function samePlanIdentity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const stageAccess = record(a.restart).access !== undefined && record(b.restart).access !== undefined;
	for (const key of ["profilePath", "profileHash", ...(stageAccess ? [] : ["remoteAccess"]), "project", "target", "targetBinding", "module"])
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
	return true;
}

function onlyStageChanged(before: Record<string, unknown>, after: Record<string, unknown>, stage: string): boolean {
	const keys = stage === "build" ? ["restart", "verify", "remoteAccess"] : stage === "upload" ? ["buildSteps", "restart", "verify", "remoteAccess"]
		: stage === "restart" ? ["buildSteps", "artifacts", "verify"] : ["buildSteps", "artifacts", "restart"];
	return keys.every((key) => JSON.stringify(before[key]) === JSON.stringify(after[key]));
}

function validateRunCompletion(run: Record<string, unknown>): void {
	if (run.finishedAt !== undefined && !Number.isSafeInteger(run.finishedAt)) throw corrupt();
	if (run.agentRunId !== undefined &&
		((["running", "recovering"].includes(String(run.status)) && run.finishedAt !== undefined) ||
			(!["running", "recovering"].includes(String(run.status)) && (!Number.isSafeInteger(run.finishedAt) || Number(run.finishedAt) < Number(run.startedAt))))) throw corrupt();
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
	if (status === "recovering" && running) throw corrupt();
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
