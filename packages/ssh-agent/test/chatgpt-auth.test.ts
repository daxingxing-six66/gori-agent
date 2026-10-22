import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_PROVIDER_ID } from "../src/domain/chatgpt.ts";
import { createSqliteManagementBackend, type SqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createChatGptFixture } from "./chatgpt-test-fixture.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

const backends: SqliteManagementBackend[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(backends.splice(0).map((backend) => backend.close())); });

function setup(extra: { databasePath?: string; loginTimeoutMs?: number } = {}) {
	const fixture = createChatGptFixture();
	const backend = createSqliteManagementBackend({ databasePath: extra.databasePath ?? ":memory:",
		credentialEncryptionKey: new Uint8Array(32).fill(7), llmModelsFactory: createTestLlmModels,
		chatgpt: { fetch: fixture.fetch, loginTimeoutMs: extra.loginTimeoutMs } });
	backends.push(backend);
	return { backend, fixture };
}

async function request(backend: SqliteManagementBackend, path: string, method = "GET", body?: unknown, origin?: string) {
	return backend.handleRequest(new Request(`http://localhost/api/llm/chatgpt${path}`, {
		method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(origin ? { origin } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	}));
}

async function begin(backend: SqliteManagementBackend, fixture: ReturnType<typeof createChatGptFixture>, newAccount = false) {
	const response = await request(backend, "/sign-in", "POST", { newAccount });
	expect(response.status).toBe(200);
	const attempt = await response.json() as { id: string; authorizationUrl: string };
	fixture.authorize(attempt.authorizationUrl);
	return attempt;
}

async function callback(authorizationUrl: string, values: Record<string, string> = {}) {
	const auth = new URL(authorizationUrl);
	const url = new URL(auth.searchParams.get("redirect_uri")!);
	url.search = new URLSearchParams({ state: auth.searchParams.get("state")!, code: "test-code", client_id: "oaiapp_test", ...values }).toString();
	return fetch(url);
}

async function waitFor(backend: SqliteManagementBackend, id: string, status = "connected") {
	await expect.poll(async () => (await (await request(backend, `/sign-in/${id}`)).json()).status, { interval: 5 }).toBe(status);
	return (await request(backend, `/sign-in/${id}`)).json();
}

describe("ChatGPT subscription authorization", () => {
	it("registers with PKCE, saves encrypted credentials, and discovers only this account's visible models in server order", async () => {
		const { backend, fixture } = setup();
		const attempt = await begin(backend, fixture);
		const url = new URL(attempt.authorizationUrl);
		expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
		expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(url.searchParams.get("agent_name_hint")).toBe("Gori");
		expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
		expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
		const confirmation = await callback(attempt.authorizationUrl);
		expect(confirmation.status).toBe(200);
		expect(confirmation.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(confirmation.headers.get("cache-control")).toBe("no-store");
		expect(confirmation.headers.get("referrer-policy")).toBe("no-referrer");
		const page = await confirmation.text();
		expect(page).toContain("ChatGPT 授权已完成");
		expect(page).toContain("请返回 Gori 查看连接结果。");
		expect(page).not.toMatch(/dummy-access|dummy-refresh|test-code|gori@example.test|<script|https?:\/\//);
		const style = page.match(/<style>([\s\S]+?)<\/style>/)![1]!;
		expect(confirmation.headers.get("content-security-policy")).toBe(`default-src 'none'; style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
		await waitFor(backend, attempt.id);
		const exchange = fixture.calls.find((call) => call.body.get("grant_type") === "authorization_code")!;
		expect(exchange.body.get("client_id")).toBe("oaiapp_test");
		expect(exchange.body.get("code_verifier")).toHaveLength(86);
		expect(exchange.body.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
		expect(exchange.body.has("client_secret")).toBe(false);
		const connection = await (await request(backend, "")).json();
		expect(connection).toMatchObject({ connected: true, sharing: true, email: "gori@example.test" });
		expect(JSON.stringify(connection)).not.toMatch(/dummy-access|dummy-refresh|idToken|access_token/);
		expect(backend.llmModelCatalog.getModels(CHATGPT_PROVIDER_ID).map((model) => model.id)).toEqual(["test-z", "test-a"]);
		const modelResponse = await backend.handleRequest(new Request(`http://localhost/api/llm/providers/${CHATGPT_PROVIDER_ID}/models`));
		expect((await modelResponse.json()).models.map((model: { id: string }) => model.id)).toEqual(["test-z", "test-a"]);
		expect(fixture.calls.find((call) => call.url.endsWith("/v1/models"))?.authorization).toBe("Bearer dummy-access");
		const secret = backend.database.prepare("SELECT ciphertext FROM llm_provider_credential_secrets WHERE provider_id = ?").get(CHATGPT_PROVIDER_ID)!;
		expect(Buffer.from(secret.ciphertext as Uint8Array).toString("utf8")).not.toContain("dummy-refresh");
		expect((await backend.llmModels.getAuth(CHATGPT_PROVIDER_ID))?.auth.apiKey).toBe("dummy-access");
	});

	it("rejects forged state before code exchange and does not publish credentials", async () => {
		const { backend, fixture } = setup();
		const attempt = await begin(backend, fixture);
		const failure = await callback(attempt.authorizationUrl, { state: "forged" });
		expect(failure.status).toBe(400);
		expect(failure.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(await waitFor(backend, attempt.id, "failed")).toMatchObject({ errorCode: "chatgpt_sign_in_failed" });
		expect(fixture.calls).toHaveLength(0);
		expect((await (await request(backend, "")).json()).connected).toBe(false);
	});

	it.each([
		{ nonce: "wrong" }, { iss: "https://attacker.test" }, { aud: "other-client" }, { exp: 1 }, { iat: 9_999_999_999 },
	])("rejects signed ID tokens with invalid claims: %j", async (claims) => {
		const { backend, fixture } = setup();
		fixture.setClaims(claims);
		const attempt = await begin(backend, fixture);
		expect((await callback(attempt.authorizationUrl)).status).toBe(400);
		await waitFor(backend, attempt.id, "failed");
		expect((await (await request(backend, "")).json()).connected).toBe(false);
	});

	it("requires plan usage consent and retains the issued registration after failure", async () => {
		const { backend, fixture } = setup();
		fixture.setScopes("openid profile email offline_access");
		const first = await begin(backend, fixture);
		expect((await callback(first.authorizationUrl)).status).toBe(400);
		expect(await waitFor(backend, first.id, "failed")).toMatchObject({ errorCode: "chatgpt_permission_required" });
		const retry = await begin(backend, fixture);
		expect(new URL(retry.authorizationUrl).searchParams.get("client_id")).toBe("oaiapp_test");
		expect(new URL(retry.authorizationUrl).searchParams.has("agent_name_hint")).toBe(false);
		expect(new URL(retry.authorizationUrl).searchParams.get("ext_agent_host_id")).toBe(new URL(first.authorizationUrl).searchParams.get("ext_agent_host_id"));
	});

	it("reports the failed stage without exposing credentials when the ID signature is invalid", async () => {
		const { backend, fixture } = setup();
		fixture.setInvalidSignature(true);
		const attempt = await begin(backend, fixture);
		const response = await callback(attempt.authorizationUrl);
		expect(await response.text()).toContain("identity: invalid_identity");
		const result = await waitFor(backend, attempt.id, "failed");
		expect(result.failure).toEqual({ stage: "identity", reason: "invalid_identity" });
		expect(JSON.stringify(result)).not.toMatch(/dummy-access|dummy-refresh|id_token|authorizationUrl/);
	});

	it("serializes concurrent refreshes and persists the replacement token", async () => {
		const { backend, fixture } = setup();
		const attempt = await begin(backend, fixture);
		await callback(attempt.authorizationUrl);
		await waitFor(backend, attempt.id);
		const future = Date.now() + 3_500_000;
		vi.spyOn(Date, "now").mockReturnValue(future);
		const auth = await Promise.all([backend.llmModels.getAuth(CHATGPT_PROVIDER_ID), backend.llmModels.getAuth(CHATGPT_PROVIDER_ID)]);
		expect(auth.map((value) => value?.auth.apiKey)).toEqual(["refreshed-access-1", "refreshed-access-1"]);
		expect(fixture.refreshCount).toBe(1);
		expect((await backend.llmModels.getAuth(CHATGPT_PROVIDER_ID))?.auth.apiKey).toBe("refreshed-access-1");
	});

	it("retains a connection after failed revocation, then clears credentials and models after confirmed revocation", async () => {
		const { backend, fixture } = setup();
		const attempt = await begin(backend, fixture);
		await callback(attempt.authorizationUrl);
		await waitFor(backend, attempt.id);
		fixture.setRevokeFail(true);
		expect((await request(backend, "", "DELETE")).status).toBe(502);
		expect((await (await request(backend, "")).json()).connected).toBe(true);
		fixture.setRevokeFail(false);
		expect((await request(backend, "", "DELETE")).status).toBe(204);
		expect((await (await request(backend, "")).json()).connected).toBe(false);
		expect(backend.llmModelCatalog.getModels(CHATGPT_PROVIDER_ID)).toEqual([]);
		expect((await backend.llmModels.getAuth(CHATGPT_PROVIDER_ID))).toBeUndefined();
	});

	it("keeps a failed refresh's current catalog but never restores another account's cached models", async () => {
		const { backend, fixture } = setup();
		const first = await begin(backend, fixture);
		await callback(first.authorizationUrl);
		await waitFor(backend, first.id);
		fixture.setModelsFail(true);
		expect((await request(backend, "/models", "POST")).status).toBe(502);
		expect(backend.llmModelCatalog.getModels(CHATGPT_PROVIDER_ID)).toHaveLength(2);
		fixture.setClaims({ sub: "different-account" });
		const second = await begin(backend, fixture, true);
		await callback(second.authorizationUrl);
		expect(await waitFor(backend, second.id)).toMatchObject({ errorCode: "chatgpt_model_discovery_failed" });
		expect(backend.llmModelCatalog.getModels(CHATGPT_PROVIDER_ID)).toEqual([]);
	});

	it("cancels and expires pending authorization and rejects remote browser origins", async () => {
		const { backend, fixture } = setup({ loginTimeoutMs: 100 });
		expect((await request(backend, "/sign-in", "POST", {}, "https://elsewhere.test")).status).toBe(400);
		const attempt = await begin(backend, fixture);
		expect((await request(backend, `/sign-in/${attempt.id}`, "DELETE")).status).toBe(204);
		expect(await waitFor(backend, attempt.id, "cancelled")).toMatchObject({ status: "cancelled" });
		const expiring = await begin(backend, fixture);
		await waitFor(backend, expiring.id, "failed");
		expect(fixture.calls).toHaveLength(0);
	});

	it("persists the host, registration and encrypted connection across restarting Gori", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gori-chatgpt-"));
		try {
			const databasePath = join(directory, "gori.sqlite");
			const { backend, fixture } = setup({ databasePath });
			const first = await begin(backend, fixture);
			await callback(first.authorizationUrl);
			await waitFor(backend, first.id);
			await backend.close();
			backends.splice(backends.indexOf(backend), 1);
			const restarted = setup({ databasePath });
			expect((await (await request(restarted.backend, "")).json()).connected).toBe(true);
			const retry = await begin(restarted.backend, restarted.fixture);
			expect(new URL(retry.authorizationUrl).searchParams.get("client_id")).toBe("oaiapp_test");
			expect(new URL(retry.authorizationUrl).searchParams.get("ext_agent_host_id")).toBe(new URL(first.authorizationUrl).searchParams.get("ext_agent_host_id"));
			const path = join(directory, "chatgpt-registration.json");
			expect(await readFile(path, "utf8")).not.toMatch(/dummy-access|dummy-refresh|idToken/);
			if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
			await restarted.backend.close();
			backends.splice(backends.indexOf(restarted.backend), 1);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});
