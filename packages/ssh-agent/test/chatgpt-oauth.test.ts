import { describe, expect, it } from "vitest";
import { ChatGptOAuthClient } from "../src/infrastructure/chatgpt/chatgpt-oauth.ts";

const exchange = { clientId: "oaiapp_test", code: "dummy-code", verifier: "dummy-verifier",
	redirectUri: "http://127.0.0.1:12345/auth/callback", nonce: "dummy-nonce" };

describe("ChatGPT OAuth request failures", () => {
	it("bounds first-token requests and distinguishes timeout from the ten-minute authorization deadline", async () => {
		const waitingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
		});
		await expect(new ChatGptOAuthClient(waitingFetch, 20).exchange(exchange, new AbortController().signal))
			.rejects.toMatchObject({ failure: { stage: "token_exchange", reason: "timeout" } });
	});

	it("reports invalid_grant with status but never returns the upstream payload", async () => {
		const response: typeof fetch = async () => Response.json({ error: "invalid_grant", error_description: "sensitive-body", access_token: "secret" }, { status: 400 });
		await expect(new ChatGptOAuthClient(response).exchange(exchange, new AbortController().signal))
			.rejects.toMatchObject({ message: "ChatGPT token_exchange: invalid_grant (HTTP 400)", failure: { stage: "token_exchange", reason: "invalid_grant", httpStatus: 400 } });
	});

	it("recognizes transport connection timeouts without leaking error messages", async () => {
		const response: typeof fetch = async () => { throw new Error("sensitive URL or token", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); };
		await expect(new ChatGptOAuthClient(response).exchange(exchange, new AbortController().signal))
			.rejects.toMatchObject({ failure: { stage: "token_exchange", reason: "timeout", transportCode: "UND_ERR_CONNECT_TIMEOUT" } });
	});

	it.each(["unsupported_country_region_territory", { code: "unsupported_country_region_territory", message: "sensitive details" }])("recognizes a region denial without confusing it with a timeout", async (error) => {
		const response: typeof fetch = async () => Response.json({ error }, { status: 403 });
		await expect(new ChatGptOAuthClient(response).exchange(exchange, new AbortController().signal))
			.rejects.toMatchObject({ failure: { stage: "token_exchange", reason: "unsupported_region", httpStatus: 403, upstreamCode: "unsupported_country_region_territory" } });
	});
});
