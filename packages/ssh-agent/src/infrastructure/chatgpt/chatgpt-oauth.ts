import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { CHATGPT_ISSUER, CHATGPT_RESOURCE, ChatGptAuthError, type ChatGptAuthFailure, type ChatGptCredential } from "../../domain/chatgpt.ts";

export class ChatGptPermissionError extends ChatGptAuthError {
	constructor() { super({ stage: "token_exchange", reason: "permission" }); }
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OpenAI OAuth response");
	return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("Incomplete OpenAI OAuth response");
	return value;
}

/** Public-client SIWC protocol. Never includes upstream response bodies in exceptions. */
export class ChatGptOAuthClient {
	private readonly fetch: typeof fetch;
	private readonly requestTimeoutMs: number;
	constructor(fetchImplementation: typeof fetch = fetch, requestTimeoutMs = 30_000) {
		this.fetch = fetchImplementation;
		this.requestTimeoutMs = requestTimeoutMs;
	}

	async exchange(input: {
		clientId: string; code: string; verifier: string; redirectUri: string; nonce: string; subject?: string;
	}, signal: AbortSignal): Promise<ChatGptCredential> {
		const tokens = await this.tokenRequest(new URLSearchParams({
			grant_type: "authorization_code", client_id: input.clientId, code: input.code,
			code_verifier: input.verifier, redirect_uri: input.redirectUri, resource: CHATGPT_RESOURCE,
		}), signal);
		const idToken = requiredString(tokens.id_token);
		const identity = await this.verifyIdentity(idToken, input.clientId, signal, input.nonce);
		if (input.subject && identity.sub !== input.subject) throw new ChatGptAuthError({ stage: "identity", reason: "invalid_identity" });
		return this.credential(tokens, {
			type: "oauth", clientId: input.clientId, subject: requiredString(identity.sub), issuer: CHATGPT_ISSUER,
			email: typeof identity.email === "string" ? identity.email : "", idToken,
			access: "", refresh: "", expires: 0, scopes: [],
		});
	}

	async refresh(credential: ChatGptCredential, signal: AbortSignal): Promise<ChatGptCredential> {
		const tokens = await this.tokenRequest(new URLSearchParams({
			grant_type: "refresh_token", client_id: credential.clientId,
			refresh_token: credential.refresh, resource: CHATGPT_RESOURCE,
		}), signal);
		let identity = credential;
		if (tokens.id_token !== undefined) {
			const idToken = requiredString(tokens.id_token);
			const claims = await this.verifyIdentity(idToken, credential.clientId, signal);
			if (claims.sub !== credential.subject) throw new Error("ChatGPT refreshed account does not match");
			identity = { ...credential, idToken, email: typeof claims.email === "string" ? claims.email : credential.email };
		}
		return this.credential(tokens, identity);
	}

	async revoke(credential: ChatGptCredential, signal: AbortSignal): Promise<void> {
		const discovery = await this.getJson(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, signal);
		if (discovery.issuer !== CHATGPT_ISSUER) throw new Error("Unexpected OpenAI issuer");
		const endpoint = new URL(requiredString(discovery.revocation_endpoint));
		if (endpoint.origin !== CHATGPT_ISSUER) throw new Error("Unexpected OpenAI revocation endpoint");
		const response = await this.request(endpoint.toString(), {
			method: "POST", redirect: "error", signal,
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: credential.refresh, token_type_hint: "refresh_token", client_id: credential.clientId }),
		}, "revocation");
		if (response.status !== 200) throw new Error(`OpenAI session revocation failed (HTTP ${response.status})`);
	}

	private credential(tokens: Record<string, unknown>, previous: ChatGptCredential): ChatGptCredential {
		const scopes = tokens.scope === undefined ? previous.scopes : requiredString(tokens.scope).split(/\s+/);
		if (!scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke")) throw new ChatGptPermissionError();
		if (typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
			typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
			throw new Error("Invalid OpenAI token lifetime or type");
		}
		return { ...previous, access: requiredString(tokens.access_token), refresh: requiredString(tokens.refresh_token),
			expires: Date.now() + tokens.expires_in * 1000, scopes };
	}

	private async tokenRequest(body: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
		const stage = body.get("grant_type") === "refresh_token" ? "refresh" : "token_exchange";
		const response = await this.request(`${CHATGPT_ISSUER}/api/accounts/oauth/token`, {
			method: "POST", redirect: "error", signal,
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body,
		}, stage);
		if (response.status !== 200) {
			let reason: ChatGptAuthFailure["reason"] = "http";
			let upstreamCode: ChatGptAuthFailure["upstreamCode"];
			try {
				const error = record(await response.json()).error;
				const code = typeof error === "string" ? error : record(error).code;
				if (code === "unsupported_country_region_territory" || code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client" || code === "access_denied") upstreamCode = code;
				if (code === "invalid_grant") reason = "invalid_grant";
				if (code === "unsupported_country_region_territory") reason = "unsupported_region";
			} catch { /* Never expose the response body. */ }
			throw new ChatGptAuthError({ stage, reason, httpStatus: response.status, ...(upstreamCode ? { upstreamCode } : {}) });
		}
		try { return record(await response.json()); }
		catch { throw new ChatGptAuthError({ stage, reason: "invalid_response" }); }
	}

	private async getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
		const response = await this.request(url, { signal, redirect: "error", headers: { accept: "application/json" } }, "identity");
		if (!response.ok) throw new ChatGptAuthError({ stage: "identity", reason: "http", httpStatus: response.status });
		try { return record(await response.json()); }
		catch { throw new ChatGptAuthError({ stage: "identity", reason: "invalid_response" }); }
	}

	private async verifyIdentity(token: string, clientId: string, signal: AbortSignal, nonce?: string): Promise<Record<string, unknown>> {
		try { return await this.verifyIdentityClaims(token, clientId, signal, nonce); }
		catch (error) {
			if (error instanceof ChatGptAuthError) throw error;
			throw new ChatGptAuthError({ stage: "identity", reason: "invalid_identity" });
		}
	}

	private async request(url: string, init: RequestInit, stage: ChatGptAuthFailure["stage"]): Promise<Response> {
		const timeout = AbortSignal.timeout(this.requestTimeoutMs);
		try {
			return await this.fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
		} catch (error) {
			const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : error;
			const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" &&
				/^(?:UND_ERR_[A-Z_]+|E[A-Z_]+)$/.test(cause.code) ? cause.code : undefined;
			throw new ChatGptAuthError({ stage, reason: timeout.aborted || /TIMEOUT|TIMEDOUT/.test(code ?? "") ? "timeout" :
				init.signal?.aborted ? "cancelled" : "network", ...(code ? { transportCode: code } : {}) });
		}
	}

	private async verifyIdentityClaims(token: string, clientId: string, signal: AbortSignal, nonce?: string): Promise<Record<string, unknown>> {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid OpenAI ID token");
		const header = record(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
		const claims = record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
		if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) throw new Error("Unsupported OpenAI ID token signature");
		const jwks = await this.getJson(`${CHATGPT_ISSUER}/.well-known/jwks.json`, signal);
		if (!Array.isArray(jwks.keys)) throw new Error("Invalid OpenAI signing keys");
		const key = jwks.keys.map(record).find((key) => key.kid === header.kid && key.kty === "RSA" &&
			(key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === "RS256"));
		if (!key || typeof key.n !== "string" || typeof key.e !== "string") throw new Error("OpenAI signing key not found");
		const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e } satisfies JsonWebKey, format: "jwk" });
		if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, "base64url"))) throw new Error("Invalid OpenAI ID token signature");
		const now = Date.now() / 1000;
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (claims.iss !== CHATGPT_ISSUER || !audiences.includes(clientId) ||
			(audiences.length > 1 && claims.azp !== clientId) || (claims.azp !== undefined && claims.azp !== clientId) ||
			typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now - 5 ||
			typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > now + 5 ||
			(claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 5)) ||
			(nonce !== undefined && claims.nonce !== nonce)) throw new Error("OpenAI ID token claims do not match");
		requiredString(claims.sub);
		return claims;
	}
}
