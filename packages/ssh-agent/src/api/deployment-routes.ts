import type { DeploymentService } from "../application/services/deployment-service.ts";
import { DeploymentError } from "../domain/deployment.ts";

export async function handleDeploymentRoute(
	deployments: DeploymentService,
	request: Request,
	segments: readonly string[],
): Promise<Response | null> {
	if (segments[0] !== "api" || segments[1] !== "sessions" || segments[3] !== "deployments" || segments.length < 4) return null;
	const sessionId = segments[2];
	if (!sessionId) return null;
	if (segments.length === 4 && request.method === "GET")
		return Response.json(await deployments.listProfiles(sessionId));
	if (segments.length === 4 && request.method === "POST") {
		let value: unknown;
		try { value = await request.json(); } catch { throw invalid(); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
		const body = value as Record<string, unknown>;
		if (Object.keys(body).length !== 2 || typeof body.file !== "string" || typeof body.moduleId !== "string") throw invalid();
		return Response.json(await deployments.prepare(sessionId, body.file, body.moduleId), { status: 201 });
	}
	if (segments.length === 5 && segments[4] === "discussions" && request.method === "POST") {
		let value: unknown;
		try { value = await request.json(); } catch { throw invalid(); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
		const body = value as Record<string, unknown>;
		if (Object.keys(body).length !== 2 || typeof body.file !== "string" || typeof body.moduleId !== "string" ||
			body.file.length > 200 || body.moduleId.length > 80) throw invalid();
		return Response.json(await deployments.beginDiscussion(sessionId, body.file, body.moduleId), { status: 201 });
	}
	if (segments.length === 6 && segments[4] === "discussions" && segments[5] === "active" && request.method === "GET")
		return Response.json(deployments.activeDiscussion(sessionId));
	if (segments.length === 6 && segments[4] === "discussions" && segments[5] && request.method === "GET")
		return Response.json(deployments.getDiscussion(sessionId, segments[5]));
	if (segments.length === 7 && segments[4] === "discussions" && segments[5] && segments[6] === "cancel" && request.method === "POST")
		return Response.json(await deployments.cancelDiscussion(sessionId, segments[5]));
	if (segments.length === 5 && segments[4] === "history" && request.method === "GET") {
		const params = new URL(request.url).searchParams;
		const rawLimit = params.get("limit");
		const cursor = params.get("cursor");
		if ([...params.keys()].some((key) => key !== "limit" && key !== "cursor") ||
			params.getAll("limit").length > 1 || params.getAll("cursor").length > 1 ||
			(rawLimit !== null && !/^[1-9]\d?$/u.test(rawLimit))) throw invalidHistoryLimit();
		const limit = rawLimit === null ? 20 : Number(rawLimit);
		if (limit > 50) throw invalidHistoryLimit();
		return Response.json(deployments.listHistory(sessionId, limit, cursor ?? undefined));
	}
	if (segments.length === 5 && request.method === "GET" && segments[4])
		return Response.json(deployments.get(sessionId, segments[4]));
	if (segments.length === 6 && request.method === "POST" && segments[4]) {
		if (segments[5] === "confirm")
			throw new DeploymentError("deployment_agent_required", "A deployment must be started by its Agent Run", 409);
		if (segments[5] === "cancel") return Response.json(await deployments.cancel(sessionId, segments[4]));
	}
	if (segments.length === 8 && request.method === "POST" && segments[4] && segments[5] === "recovery" && segments[6] &&
		(segments[7] === "approve" || segments[7] === "reject"))
		return Response.json(await deployments.decideRecovery(sessionId, segments[4], segments[6], segments[7] === "approve"));
	if (segments.length === 9 && request.method === "POST" && segments[4] && segments[5] === "approvals" &&
		(segments[6] === "restart" || segments[6] === "verify") && segments[7] &&
		(segments[8] === "approve" || segments[8] === "reject"))
		return Response.json(deployments.decideFullAccess(sessionId, segments[4], segments[6], segments[7], segments[8] === "approve"));
	return null;
}

function invalid(): DeploymentError {
	return new DeploymentError("deployment_request_invalid", "Expected file and moduleId", 400);
}

function invalidHistoryLimit(): DeploymentError {
	return new DeploymentError("deployment_request_invalid", "History limit must be between 1 and 50", 400);
}
