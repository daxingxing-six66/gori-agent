import { apiRequest } from "@/shared/api/client";
import { isDeploymentDiscovery, isDeploymentRun, type DeploymentDiscovery, type DeploymentRun } from "../model/deployment";

const root = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/deployments`;

function requireRun(value: unknown, sessionId: string, runId?: string): DeploymentRun {
	if (!isDeploymentRun(value) || value.sessionId !== sessionId || (runId && value.id !== runId))
		throw new Error("Invalid deployment response");
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
	async history(sessionId: string, cursor?: string): Promise<{ runs: DeploymentRun[]; nextCursor: string | null }> {
		const query = new URLSearchParams({ limit: "50" });
		if (cursor !== undefined) query.set("cursor", cursor);
		const response: unknown = await apiRequest(`${root(sessionId)}/history?${query}`);
		if (!isHistoryPage(response, sessionId)) throw new Error("Invalid deployment history response");
		return { runs: response.runs, nextCursor: response.nextCursor };
	},
	async discover(sessionId: string): Promise<DeploymentDiscovery> {
		const response: unknown = await apiRequest(root(sessionId));
		if (!isDeploymentDiscovery(response) || (response.latest && response.latest.sessionId !== sessionId))
			throw new Error("Invalid deployment discovery response");
		return response;
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
	async cancel(sessionId: string, id: string): Promise<DeploymentRun> {
		return requireRun(await apiRequest(`${root(sessionId)}/${encodeURIComponent(id)}/cancel`, { method: "POST" }), sessionId, id);
	},
};
