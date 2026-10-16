import { validSandboxWritableRoots } from "../../domain/sandbox-writable-roots.ts";
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, normalize, posix } from "node:path";
import type {
	DeploymentDiscussionRepository, DeploymentDiscussionRunBinding,
} from "../../application/repositories/deployment-discussion-repository.ts";
import { DeploymentError, type DeploymentDiscussion } from "../../domain/deployment.ts";

const COLUMNS = "id, session_id, workspace_id, status, revision, snapshot_json, created_at, updated_at";

export class SqliteDeploymentDiscussionRepository implements DeploymentDiscussionRepository {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) { this.database = database; }

	find(sessionId: string, id: string): DeploymentDiscussion | undefined {
		const row = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_discussions WHERE session_id = ? AND id = ?`).get(sessionId, id);
		return row === undefined ? undefined : parseRow(row);
	}

	findActive(sessionId: string): DeploymentDiscussion | undefined {
		const row = this.database.prepare(`SELECT ${COLUMNS} FROM deployment_discussions WHERE session_id = ? AND status = 'discussing'`).get(sessionId);
		return row === undefined ? undefined : parseRow(row);
	}

	findRunBinding(sessionId: string, agentRunId: string): DeploymentDiscussionRunBinding | undefined {
		const row = this.database.prepare(`SELECT discussion_id, session_id, agent_run_id, revision
			FROM deployment_discussion_runs WHERE session_id = ? AND agent_run_id = ?`).get(sessionId, agentRunId);
		return row === undefined ? undefined : parseRunBinding(row);
	}

	findLatestRunBinding(discussionId: string): DeploymentDiscussionRunBinding | undefined {
		const row = this.database.prepare(`SELECT discussion_id, session_id, agent_run_id, revision
			FROM deployment_discussion_runs WHERE discussion_id = ? ORDER BY revision DESC LIMIT 1`).get(discussionId);
		return row === undefined ? undefined : parseRunBinding(row);
	}

	insert(discussion: DeploymentDiscussion): void {
		this.database.prepare(`INSERT INTO deployment_discussions
			(id, session_id, workspace_id, status, revision, snapshot_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
			discussion.id, discussion.sessionId, discussion.workspaceId, discussion.status, discussion.revision,
			JSON.stringify(discussion), discussion.createdAt, discussion.updatedAt,
		);
	}

	updateDiscussing(discussion: DeploymentDiscussion, expectedRevision: number): boolean {
		const result = this.database.prepare(`UPDATE deployment_discussions
			SET status = ?, revision = ?, snapshot_json = ?, updated_at = ?
			WHERE id = ? AND session_id = ? AND status = 'discussing' AND revision = ?`).run(
			discussion.status, discussion.revision, JSON.stringify(discussion), discussion.updatedAt,
			discussion.id, discussion.sessionId, expectedRevision,
		);
		return result.changes === 1;
	}

	insertRunBinding(binding: DeploymentDiscussionRunBinding): void {
		this.database.prepare(`INSERT INTO deployment_discussion_runs
			(discussion_id, session_id, agent_run_id, revision) VALUES (?, ?, ?, ?)`).run(
			binding.discussionId, binding.sessionId, binding.agentRunId, binding.revision,
		);
	}
}

function parseRunBinding(value: unknown): DeploymentDiscussionRunBinding {
	const row = record(value);
	if (!validId(row.discussion_id) || !validId(row.session_id) || !validId(row.agent_run_id) ||
		!positiveInteger(row.revision)) throw corrupt();
	return {
		discussionId: row.discussion_id,
		sessionId: row.session_id,
		agentRunId: row.agent_run_id,
		revision: row.revision,
	};
}

function parseRow(value: unknown): DeploymentDiscussion {
	const row = record(value);
	if (!validId(row.id) || !validId(row.session_id) || !validId(row.workspace_id) ||
		!positiveInteger(row.revision) || !nonnegativeInteger(row.created_at) || !nonnegativeInteger(row.updated_at) ||
		typeof row.snapshot_json !== "string" || !["discussing", "proposed", "cancelled"].includes(String(row.status))) throw corrupt();
	let parsed: unknown;
	try { parsed = JSON.parse(row.snapshot_json); } catch { throw corrupt(); }
	const discussion = record(parsed);
	if (!exactKeys(discussion, ["id", "sessionId", "workspaceId", "status", "revision", "profileFile", "profileHash",
		"projectRoot", "project", "module", "targetBinding", "createdAt", "updatedAt"], ["deploymentRunId"]) ||
		discussion.id !== row.id || discussion.sessionId !== row.session_id || discussion.workspaceId !== row.workspace_id ||
		discussion.status !== row.status || discussion.revision !== row.revision || discussion.createdAt !== row.created_at ||
		discussion.updatedAt !== row.updated_at || Number(discussion.updatedAt) < Number(discussion.createdAt) ||
		!text(discussion.profileFile, 200) || !/^deploy-[a-zA-Z0-9._-]+\.md$/u.test(discussion.profileFile) ||
		typeof discussion.profileHash !== "string" || !/^[a-f0-9]{64}$/u.test(discussion.profileHash) ||
		!absolutePath(discussion.projectRoot) || !text(discussion.project, 200)) throw corrupt();
	const module = record(discussion.module);
	if (!exactKeys(module, ["id", "name"]) || !text(module.id, 80) ||
		!/^[a-z0-9][a-z0-9_-]*$/u.test(module.id) || !text(module.name, 200)) throw corrupt();
	const target = record(discussion.targetBinding);
	if (!exactKeys(target, ["hostname", "port", "workspaceRevision", "hostKeyAlgorithm", "hostKeyFingerprint",
		"credentialId", "credentialAuthVersion", "remoteUser"], ["writableRoot", "sandboxWritableRoots"]) ||
		!text(target.hostname, 255) || !positiveInteger(target.port) || Number(target.port) > 65535 ||
		!positiveInteger(target.workspaceRevision) || !text(target.hostKeyAlgorithm, 200) ||
		!text(target.hostKeyFingerprint, 500) || !validId(target.credentialId) ||
		!positiveInteger(target.credentialAuthVersion) || !text(target.remoteUser, 200) ||
		(target.writableRoot !== undefined && (!text(target.writableRoot, 2048) || !posix.isAbsolute(target.writableRoot) ||
			posix.normalize(target.writableRoot) !== target.writableRoot)) ||
		(target.sandboxWritableRoots !== undefined && !validSandboxWritableRoots(target.sandboxWritableRoots, true))) throw corrupt();
	if (discussion.status === "proposed") {
		if (!validId(discussion.deploymentRunId)) throw corrupt();
	} else if (discussion.deploymentRunId !== undefined) throw corrupt();
	return parsed as DeploymentDiscussion;
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw corrupt();
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	return required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 200 &&
		value === value.trim() && !/[\0-\x1f]/u.test(value);
}

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max &&
		value === value.trim() && !/[\0-\x1f]/u.test(value);
}

function absolutePath(value: unknown): value is string {
	return text(value, 2048) && isAbsolute(value) && normalize(value) === value;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function corrupt(): DeploymentError {
	return new DeploymentError("deployment_data_corrupt", "Saved deployment discussion is invalid", 500);
}
