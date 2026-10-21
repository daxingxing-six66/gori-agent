import { generateKeyPairSync, sign } from "node:crypto";
import { CHATGPT_ISSUER, CHATGPT_RESOURCE } from "../src/domain/chatgpt.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const signingJwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };

export function idToken(claims: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ iss: CHATGPT_ISSUER, sub: "test-subject", aud: "oaiapp_test",
		iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, email: "gori@example.test", ...claims })).toString("base64url");
	return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
}

export function createChatGptFixture() {
	const calls: { url: string; body: URLSearchParams; authorization: string | null }[] = [];
	let nonce = "";
	let claims: Record<string, unknown> = {};
	let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
	let models: unknown = { models: [
		{ slug: "test-z", display_name: "Z model", visibility: "list" },
		{ slug: "hidden", display_name: "Hidden", visibility: "hidden" },
		{ slug: "test-a", display_name: "A model", visibility: "list" },
	] };
	let modelsFail = false;
	let revokeFail = false;
	let refreshCount = 0;
	let invalidSignature = false;
	const mockFetch: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const body = new URLSearchParams(typeof init?.body === "string" || init?.body instanceof URLSearchParams ? init.body : undefined);
		calls.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
		if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [signingJwk] });
		if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: CHATGPT_ISSUER, revocation_endpoint: `${CHATGPT_ISSUER}/oauth/revoke` });
		if (url.endsWith("/oauth/revoke")) return new Response(null, { status: revokeFail ? 503 : 200 });
		if (url === `${CHATGPT_RESOURCE}/models`) return modelsFail ? new Response("unavailable", { status: 503 }) : Response.json(models);
		if (url.endsWith("/api/accounts/oauth/token")) {
			if (body.get("grant_type") === "refresh_token") {
				refreshCount++;
				return Response.json({ access_token: `refreshed-access-${refreshCount}`, refresh_token: `rotated-refresh-${refreshCount}`,
					token_type: "Bearer", expires_in: 3600 });
			}
			const token = idToken({ nonce, ...claims });
			return Response.json({ access_token: "dummy-access", refresh_token: "dummy-refresh", id_token: invalidSignature ? `${token.slice(0, -10)}AAAAAAAAAA` : token,
				token_type: "Bearer", expires_in: 3600, scope: scopes });
		}
		throw new Error(`Unexpected test URL: ${url}`);
	};
	return {
		fetch: mockFetch, calls,
		authorize(url: string) { nonce = new URL(url).searchParams.get("nonce")!; },
		setClaims(value: Record<string, unknown>) { claims = value; },
		setInvalidSignature(value: boolean) { invalidSignature = value; },
		setScopes(value: string) { scopes = value; },
		setModels(value: unknown) { models = value; },
		setModelsFail(value: boolean) { modelsFail = value; },
		setRevokeFail(value: boolean) { revokeFail = value; },
		get refreshCount() { return refreshCount; },
	};
}
