import { chatGptError, type ChatGptService } from "../application/services/chatgpt-service.ts";
import { ManagementError } from "../domain/errors.ts";

export async function handleChatGptRoute(service: ChatGptService, request: Request, segments: string[]): Promise<Response | null> {
	if (segments[0] !== "api" || segments[1] !== "llm" || segments[2] !== "chatgpt") return null;
	if (segments.length === 3) {
		if (request.method === "GET") return json(await service.connection());
		if (request.method === "DELETE") { await service.disconnect(); return new Response(null, { status: 204 }); }
	}
	if (segments.length === 4 && segments[3] === "sign-in" && request.method === "POST") {
		// The loopback callback must reach the same computer as Gori. JSON prevents blind form POSTs.
		const origin = request.headers.get("origin");
		if (origin && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw chatGptError("local_browser_required", 400);
		if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ManagementError("validation_error", "Expected JSON sign-in request");
		const body: unknown = await request.json();
		if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "newAccount") ||
			("newAccount" in body && typeof body.newAccount !== "boolean")) throw new ManagementError("validation_error", "Invalid ChatGPT sign-in request");
		return json(await service.begin("newAccount" in body && body.newAccount === true));
	}
	if (segments.length === 5 && segments[3] === "sign-in") {
		if (request.method === "GET") return json(service.status(segments[4]!));
		if (request.method === "DELETE") { await service.cancel(segments[4]!); return new Response(null, { status: 204 }); }
	}
	if (segments.length === 4 && segments[3] === "models" && request.method === "POST") {
		await service.refreshModels();
		return new Response(null, { status: 204 });
	}
	return null;
}

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
