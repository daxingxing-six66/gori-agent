import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { CHATGPT_ISSUER, CHATGPT_RESOURCE, ChatGptAuthError, type ChatGptCredential } from "../../domain/chatgpt.ts";
import type { ChatGptOAuthClient } from "./chatgpt-oauth.ts";
import type { ChatGptRegistrationStore } from "./chatgpt-registration-store.ts";
import type { ChatGptLogin } from "../../application/chatgpt-authorization.ts";

/** The listener is local to the Gori runtime, never a public HTTP callback. */
export async function startChatGptLogin(options: {
	oauth: ChatGptOAuthClient;
	registrations: ChatGptRegistrationStore;
	previous?: ChatGptCredential;
	newAccount: boolean;
	timeoutMs?: number;
}): Promise<ChatGptLogin> {
	const registration = options.registrations.read();
	const savedClientId = options.newAccount ? undefined : options.previous?.clientId ?? registration.clientId;
	const subject = options.newAccount ? undefined : options.previous?.subject ?? registration.subject;
	const state = randomBytes(32).toString("base64url");
	const nonce = randomBytes(32).toString("base64url");
	const verifier = randomBytes(64).toString("base64url");
	const controller = new AbortController();
	let resolveResult: (credential: ChatGptCredential) => void;
	let rejectResult: (reason: unknown) => void;
	const result = new Promise<ChatGptCredential>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
	// A bind error or timeout can happen before the caller has attached its handler.
	void result.catch(() => undefined);
	let consumed = false;
	let redirectUri = "";
	const server = createServer((request, response) => {
		let url: URL;
		try { url = new URL(request.url ?? "/", redirectUri); }
		catch { response.writeHead(400).end(); return; }
		if (request.method !== "GET" || url.pathname !== "/auth/callback" ||
			request.headers.host !== new URL(redirectUri).host || url.origin !== new URL(redirectUri).origin) {
			response.writeHead(404).end();
			return;
		}
		if (consumed) { response.writeHead(409).end(); return; }
		consumed = true;
		void (async () => {
			try {
				if (url.searchParams.get("state") !== state) throw new ChatGptAuthError({ stage: "callback", reason: "state" });
				if (url.searchParams.has("error")) throw new ChatGptAuthError({ stage: "callback", reason: "permission" });
				const code = url.searchParams.get("code");
				const returnedClientId = url.searchParams.get("client_id");
				const clientId = savedClientId ?? returnedClientId;
				if (!code || !clientId || clientId === "dynamic_agent_client" ||
					(savedClientId && returnedClientId && savedClientId !== returnedClientId)) throw new ChatGptAuthError({ stage: "callback", reason: "client_id" });
				// Retain the issued ID even if this authorization code expires before exchange.
				options.registrations.save(clientId, subject);
				const credential = await options.oauth.exchange({ clientId, code, verifier, redirectUri, nonce, subject }, controller.signal);
				controller.signal.throwIfAborted();
				options.registrations.save(clientId, credential.subject);
				resolveResult!(credential);
				response.writeHead(200, callbackHeaders).end("ChatGPT authorization received. Return to Gori to check the connection. / 请返回 Gori 查看连接结果。");
			} catch (error) {
				rejectResult!(error);
				const failure = error instanceof ChatGptAuthError ? error.failure : { stage: "callback", reason: "invalid_response" };
				console.warn("ChatGPT authorization failed", failure);
				response.writeHead(400, callbackHeaders).end(`ChatGPT sign-in failed. Return to Gori and try again. / 登录失败，请返回 Gori 重试。\n${failure.stage}: ${failure.reason}${"httpStatus" in failure ? ` (HTTP ${failure.httpStatus})` : ""}${"transportCode" in failure ? ` [${failure.transportCode}]` : ""}${"upstreamCode" in failure ? ` [${failure.upstreamCode}]` : ""}`);
			} finally {
				clearTimeout(timer);
				server.close();
				server.closeIdleConnections();
			}
		})();
	});
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	const cancel = (expired = false) => {
		clearTimeout(timer);
		controller.abort();
		rejectResult!(new ChatGptAuthError({ stage: "callback", reason: expired ? "timeout" : "cancelled" }));
		server.close();
		server.closeAllConnections();
	};
	const timer = setTimeout(() => cancel(true), options.timeoutMs ?? 10 * 60_000);
	timer.unref();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") { reject(new Error("ChatGPT callback listener unavailable")); return; }
				redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
				server.removeListener("error", reject);
				resolve();
			});
		});
	} catch (error) { clearTimeout(timer); cancel(); throw error; }
	server.on("error", () => cancel());
	server.unref();
	const url = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
	url.search = new URLSearchParams({
		client_id: savedClientId ?? "dynamic_agent_client",
		...(savedClientId ? {} : { agent_name_hint: "Gori" }),
		ext_agent_host_id: registration.hostId,
		response_type: "code", redirect_uri: redirectUri,
		scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		resource: CHATGPT_RESOURCE, state, nonce, code_challenge_method: "S256",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		...(!options.newAccount && options.previous?.email ? { login_hint: options.previous.email } : {}),
	}).toString();
	return { authorizationUrl: url.toString(), result, signal: controller.signal, cancel: () => { clearTimeout(timer); cancel(); } };
}

const callbackHeaders = {
	"content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
	"referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};
