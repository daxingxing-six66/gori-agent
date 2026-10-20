import type { DiagnoseChatCoordinator, DiagnoseChatInput } from "../application/services/diagnose-chat-coordinator.ts";
import type { DiagnoseService } from "../application/services/diagnose-service.ts";
import { DiagnoseError, diagnoseObject, diagnoseText } from "../domain/diagnose.ts";
import { parseCreateChatRun } from "./request-validation.ts";

export async function handleDiagnoseRoute(service: DiagnoseService, coordinator: DiagnoseChatCoordinator, request: Request, segments: readonly string[]): Promise<Response | null> {
	if (segments[0] !== "api" || segments[1] !== "sessions" || !segments[2] || segments[3] !== "diagnoses") return null;
	const sessionId = segments[2];
	if (segments.length === 4 && request.method === "POST") return Response.json(await coordinator.start(sessionId, await chatInput(request)), { status: 201 });
	if (segments.length === 5 && request.method === "GET") {
		if (segments[4] === "active") return Response.json(service.active(sessionId));
		return Response.json(service.get(sessionId, segments[4]!));
	}
	if (segments.length !== 6 || !segments[4]) return null;
	const taskId = segments[4];
	if (request.method === "GET" && segments[5] === "nodes") {
		const params = new URL(request.url).searchParams;
		for (const key of params.keys()) if (!["beforeSequence", "limit"].includes(key) || params.getAll(key).length !== 1)
			throw new DiagnoseError("diagnose_request_invalid", "Unknown or repeated pagination field", 400, key);
		const number = (key: string) => {
			const raw = params.get(key);
			if (raw === null) return undefined;
			if (!/^[1-9]\d*$/u.test(raw)) throw new DiagnoseError("diagnose_request_invalid", `${key} must be a positive integer`, 400, key);
			return Number(raw);
		};
		return Response.json(service.nodes(sessionId, taskId, number("beforeSequence"), number("limit")));
	}
	if (request.method === "GET" && segments[5] === "conclusion") return Response.json({ markdown: service.conclusion(sessionId, taskId) });
	if (request.method === "POST" && segments[5] === "conclusion-requests") return Response.json(await coordinator.conclude(sessionId, taskId, await chatInput(request)));
	if (request.method === "POST" && segments[5] === "cancel") return Response.json(await coordinator.cancel(sessionId, taskId));
	return null;
}

async function chatInput(request: Request): Promise<DiagnoseChatInput> {
	let value: unknown;
	try { value = await request.json(); } catch { throw new DiagnoseError("diagnose_request_invalid", "body must contain valid JSON", 400, "body"); }
	const body = diagnoseObject(value, ["requestId", "problem", "attachmentIds", "providerId", "modelId", "thinkingLevel", "serverInteractionMode"]);
	const problem = body.problem === undefined ? undefined : diagnoseText(body.problem, "problem", 65_536, true, true);
	const { problem: _problem, ...chatFields } = body;
	const parsed = parseCreateChatRun({ ...chatFields, message: problem?.trim() || "Diagnosis", serverInteractionMode: body.serverInteractionMode ?? "command" });
	// The shared Chat parser owns model/thinking/attachment validation. It accepts only Chat keys.
	return { requestId: diagnoseText(parsed.requestId, "requestId", 200), problem, attachmentIds: parsed.attachmentIds,
		providerId: parsed.providerId, modelId: parsed.modelId, thinkingLevel: parsed.thinkingLevel, serverInteractionMode: parsed.serverInteractionMode };
}
