import { apiRequest } from "@/shared/api/client";
import { isDeploymentDiscussion, isDeploymentDiscovery, isDeploymentRun, type DeploymentDiscussion, type DeploymentDiscovery, type DeploymentRun } from "../model/deployment";
import { isDeploymentTask, isDeploymentLogChunk, type DeploymentTask, type DeploymentLogPage } from "../model/deployment-task";
import type { DeploymentExecutableStage } from "../model/deployment";

const root = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/deployments`;

function requireRun(value: unknown, sessionId: string, runId?: string): DeploymentRun {
	if (!isDeploymentRun(value) || value.sessionId !== sessionId || (runId && value.id !== runId))
		throw new Error("Invalid deployment response");
	return value;
}

function requireDiscussion(value: unknown, sessionId: string, discussionId?: string): DeploymentDiscussion {
	if (!isDeploymentDiscussion(value) || value.sessionId !== sessionId ||
		(discussionId !== undefined && value.id !== discussionId))
		throw new Error("Invalid deployment discussion response");
	return value;
}

function isHistoryPage(value: unknown, sessionId: string): value is { runs: DeploymentRun[]; hasMore: boolean; nextCursor: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		!("runs" in value) || !Array.isArray(value.runs) ||
		!value.runs.every((run) => isDeploymentRun(run) && run.sessionId === sessionId) ||
		!("hasMore" in value) || typeof value.hasMore !== "boolean" ||
		!("nextCursor" in value)) return false;
	return value.hasMore ? typeof value.nextCursor === "string" && value.nextCursor.length > 0 : value.nextCursor === null;
}

export const deploymentApi = {
	async mode(sessionId: string): Promise<DeploymentTask | null> {
		const value: unknown = await apiRequest(`${root(sessionId)}/mode`);
		if (value === null) return null;
		return requireTask(value, sessionId);
	},
	async task(sessionId: string, id: string): Promise<DeploymentTask> {
		return requireTask(await apiRequest(`${root(sessionId)}/tasks/${encodeURIComponent(id)}/state`), sessionId, id);
	},
	async finish(sessionId: string, id: string, outcome: "cancelled" | "failed", reason?: string): Promise<DeploymentTask> {
		return requireTask(await apiRequest(`${root(sessionId)}/tasks/${encodeURIComponent(id)}/finish`, {
			method: "POST", body: { outcome, ...(reason === undefined ? {} : { reason }) },
		}), sessionId, id);
	},
	async logs(sessionId: string, id: string, stage: DeploymentExecutableStage, afterSequence: number): Promise<DeploymentLogPage> {
		const value: unknown = await apiRequest(`${root(sessionId)}/${encodeURIComponent(id)}/logs?${new URLSearchParams({ stage, afterSequence: String(afterSequence) })}`);
		if (!value || typeof value !== "object" || !("chunks" in value) || !Array.isArray(value.chunks) ||
			!value.chunks.every((chunk) => isDeploymentLogChunk(chunk) && chunk.deploymentRunId === id && chunk.stage === stage && chunk.sequence > afterSequence) ||
			!("nextSequence" in value) || !Number.isSafeInteger(value.nextSequence) || Number(value.nextSequence) < afterSequence ||
			!("hasMore" in value) || typeof value.hasMore !== "boolean" ||
			value.nextSequence !== (value.chunks.at(-1)?.sequence ?? afterSequence) || value.hasMore && value.chunks.length === 0)
			throw new Error("Invalid deployment logs response");
		return value as DeploymentLogPage;
	},
	async history(sessionId: string, cursor?: string): Promise<{ runs: DeploymentRun[]; nextCursor: string | null }> {
		const query = new URLSearchParams({ limit: "50" });
		if (cursor !== undefined) query.set("cursor", cursor);
		const response: unknown = await apiRequest(`${root(sessionId)}/history?${query}`);
		if (!isHistoryPage(response, sessionId)) throw new Error("Invalid deployment history response");
		return { runs: response.runs, nextCursor: response.nextCursor };
	},
	async discover(sessionId: string): Promise<DeploymentDiscovery> {
		const response: unknown = await apiRequest(root(sessionId));
		if (!isDeploymentDiscovery(response) || (response.latest && response.latest.sessionId !== sessionId) ||
			(response.activeDiscussion && response.activeDiscussion.sessionId !== sessionId))
			throw new Error("Invalid deployment discovery response");
		return response;
	},
	async beginDiscussion(sessionId: string, file: string, moduleId: string): Promise<DeploymentDiscussion> {
		const response: unknown = await apiRequest(`${root(sessionId)}/discussions`, { method: "POST", body: { file, moduleId } });
		return requireDiscussion(response, sessionId);
	},
	async getDiscussion(sessionId: string, discussionId: string): Promise<DeploymentDiscussion> {
		const response: unknown = await apiRequest(`${root(sessionId)}/discussions/${encodeURIComponent(discussionId)}`);
		return requireDiscussion(response, sessionId, discussionId);
	},
	async activeDiscussion(sessionId: string): Promise<DeploymentDiscussion | null> {
		const response: unknown = await apiRequest(`${root(sessionId)}/discussions/active`);
		if (response === null) return null;
		const discussion = requireDiscussion(response, sessionId);
		if (discussion.status !== "discussing") throw new Error("Invalid active deployment discussion response");
		return discussion;
	},
	async cancelDiscussion(sessionId: string, discussionId: string): Promise<DeploymentDiscussion> {
		const response: unknown = await apiRequest(`${root(sessionId)}/discussions/${encodeURIComponent(discussionId)}/cancel`, { method: "POST" });
		return requireDiscussion(response, sessionId, discussionId);
	},
	async prepare(sessionId: string, file: string, moduleId: string): Promise<DeploymentRun> {
		return requireRun(await apiRequest(root(sessionId), { method: "POST", body: { file, moduleId } }), sessionId);
	},
	async get(sessionId: string, id: string): Promise<DeploymentRun> {
		return requireRun(await apiRequest(`${root(sessionId)}/${encodeURIComponent(id)}`), sessionId, id);
	},
	async decideFullAccess(sessionId: string, id: string, stage: "restart" | "verify", approvalId: string, approved: boolean): Promise<DeploymentRun> {
		return requireRun(await apiRequest(`${root(sessionId)}/${encodeURIComponent(id)}/approvals/${stage}/${encodeURIComponent(approvalId)}/${approved ? "approve" : "reject"}`, { method: "POST" }), sessionId, id);
	},
	async decideRecovery(sessionId: string, id: string, proposalId: string, approved: boolean): Promise<DeploymentRun> {
		return requireRun(await apiRequest(`${root(sessionId)}/${encodeURIComponent(id)}/recovery/${encodeURIComponent(proposalId)}/${approved ? "approve" : "reject"}`, { method: "POST" }), sessionId, id);
	},
	async cancel(sessionId: string, id: string): Promise<DeploymentRun> {
		return requireRun(await apiRequest(`${root(sessionId)}/${encodeURIComponent(id)}/cancel`, { method: "POST" }), sessionId, id);
	},
};

function requireTask(value: unknown, sessionId: string, id?: string): DeploymentTask {
	if (!isDeploymentTask(value) || value.deployment.sessionId !== sessionId || id !== undefined && value.deployment.id !== id)
		throw new Error("Invalid deployment task response");
	return value;
}
