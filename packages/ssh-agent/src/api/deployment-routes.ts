import type { DeploymentService } from "../application/services/deployment-service.ts";
import { DeploymentError } from "../domain/deployment.ts";
import { deploymentInputError, deploymentObject, deploymentText } from "../application/deployment-validation.ts";

export async function handleDeploymentRoute(
	deployments: DeploymentService,
	request: Request,
	segments: readonly string[],
): Promise<Response | null> {
	if (segments[0] !== "api" || segments[1] !== "sessions" || segments[3] !== "deployments" || segments.length < 4) return null;
	const sessionId = segments[2];
	if (!sessionId) return null;
	if (segments.length === 5 && segments[4] === "mode" && request.method === "GET")
		return Response.json(deployments.activeMode(sessionId));
	if (segments.length === 7 && segments[4] === "tasks" && segments[5] && request.method === "GET" && segments[6] === "state")
		return Response.json(deployments.getMode(sessionId, segments[5]));
	if (segments.length === 7 && segments[4] === "tasks" && segments[5] && request.method === "POST" && segments[6] === "finish") {
		const body = await readBody(request, ["outcome", "reason"]);
		if (body.outcome !== "cancelled" && body.outcome !== "failed")
			deploymentInputError("deployment_request_invalid", "outcome", "user requests must be cancelled or failed; only the model can request success after stage verification");
		if (body.reason !== undefined) deploymentText(body.reason, "reason", 4_000, "deployment_request_invalid");
		return Response.json(await deployments.finishDeployment(sessionId, segments[5], body.outcome, body.reason as string | undefined));
	}
	if (segments.length === 4 && request.method === "GET")
		return Response.json(await deployments.listProfiles(sessionId));
	if (segments.length === 4 && request.method === "POST") {
		const body = await readBody(request, ["file", "moduleId"]);
		const file = deploymentText(body.file, "file", 200, "deployment_request_invalid");
		const moduleId = deploymentText(body.moduleId, "moduleId", 80, "deployment_request_invalid");
		return Response.json(await deployments.prepare(sessionId, file, moduleId), { status: 201 });
	}
	if (segments.length === 5 && segments[4] === "discussions" && request.method === "POST") {
		const body = await readBody(request, ["file", "moduleId"]);
		const file = deploymentText(body.file, "file", 200, "deployment_request_invalid");
		const moduleId = deploymentText(body.moduleId, "moduleId", 80, "deployment_request_invalid");
		return Response.json(await deployments.beginDiscussion(sessionId, file, moduleId), { status: 201 });
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
		validateQuery(params, "history", ["limit", "cursor"]);
		if (rawLimit !== null && !/^[1-9]\d?$/u.test(rawLimit))
			deploymentInputError("deployment_request_invalid", "history.limit", "must be an integer between 1 and 50");
		const limit = rawLimit === null ? 20 : Number(rawLimit);
		if (limit > 50) deploymentInputError("deployment_request_invalid", "history.limit", "must be between 1 and 50");
		return Response.json(deployments.listHistory(sessionId, limit, cursor ?? undefined));
	}
	if (segments.length === 5 && request.method === "GET" && segments[4])
		return Response.json(deployments.get(sessionId, segments[4]));
	if (segments.length === 6 && segments[4] && segments[5] === "logs" && request.method === "GET") {
		const params = new URL(request.url).searchParams;
		const stage = params.get("stage");
		const after = params.get("afterSequence") ?? "0";
		const limit = params.get("limit") ?? "200";
		validateQuery(params, "logs", ["stage", "afterSequence", "limit"]);
		if (stage !== "build" && stage !== "upload" && stage !== "restart" && stage !== "verify")
			deploymentInputError("deployment_request_invalid", "logs.stage", "must be build, upload, restart or verify");
		if (!/^(0|[1-9]\d*)$/u.test(after) || !Number.isSafeInteger(Number(after)))
			deploymentInputError("deployment_request_invalid", "logs.afterSequence", "must be a nonnegative safe integer");
		if (!/^[1-9]\d{0,2}$/u.test(limit) || Number(limit) > 500)
			deploymentInputError("deployment_request_invalid", "logs.limit", "must be an integer between 1 and 500");
		return Response.json(deployments.logs(sessionId, segments[4], stage, Number(after), Number(limit)));
	}
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

async function readBody(request: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
	let value: unknown;
	try { value = await request.json(); }
	catch { deploymentInputError("deployment_request_invalid", "body", "must contain valid JSON"); }
	return deploymentObject(value, "request", allowed, "deployment_request_invalid");
}

function validateQuery(params: URLSearchParams, scope: string, allowed: readonly string[]): void {
	for (const key of params.keys()) {
		if (!allowed.includes(key)) deploymentInputError("deployment_request_invalid", `${scope}.${key}`, `unknown query parameter; allowed parameters: ${allowed.join(", ")}`);
		if (params.getAll(key).length !== 1) deploymentInputError("deployment_request_invalid", `${scope}.${key}`, "must occur exactly once");
	}
}
