import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	annotateProviderFailure,
	normalizeProviderFailure,
	providerFailureStream,
} from "../src/application/provider-failure.ts";
import { localizePublicValue } from "../src/i18n/projection.ts";

const model = fauxProvider({ provider: "errors", models: [{ id: "model" }] }).getModel();

describe("provider failure boundary", () => {
	it("redacts whole quoted credentials and header dumps", () => {
		for (const text of [
			'password="secret phrase" max_tokens=8192',
			"refresh_token=secret-value max_tokens=8192",
			"Cookie: session=first-secret; auth=second-secret\nmax_tokens=8192",
		]) {
			const result = normalizeProviderFailure(model, text, "response");
			expect(result?.reason).toContain("max_tokens=8192");
			expect(result?.reason).not.toMatch(/secret|phrase/);
		}
	});

	it("prefers structured errors over malformed diagnostic text", () => {
		expect(
			normalizeProviderFailure(model, {
				status: 400,
				message: "400: {broken",
				error: { code: "invalid_request", message: "max_tokens must be <= 8192" },
			}),
		).toMatchObject({ reason: "max_tokens must be <= 8192", retryable: false });
	});

	it("does not retry permanent restrictions hidden behind HTTP 429 or 500", () => {
		for (const message of [
			"Country, region, or territory not supported",
			"max_tokens exceeds the model limit",
			"Quota has been exhausted",
		]) {
			expect(normalizeProviderFailure(model, { status: 429, message })?.retryable).toBe(false);
		}
	});
	it.each([
		[403, "unsupported_country_region_territory", "Country not supported", false],
		[400, "invalid_request", "max_tokens must be at most 8192", false],
		[429, "insufficient_quota", "Quota exhausted", false],
		[429, "rate_limit", "Too many requests", true],
		[401, "invalid_api_key", "Invalid API key", false],
		[402, "balance", "Insufficient balance", false],
		[503, "unavailable", "Service unavailable", true],
	] as const)("normalizes HTTP %s %s", (status, code, message, retryable) => {
		for (const value of [
			{ status, error: { code, message } },
			`OpenAI API error (${status}): ${JSON.stringify({ error: { code, message } })}`,
		]) {
			expect(normalizeProviderFailure(model, value)).toMatchObject({
				upstreamStatus: status,
				upstreamCode: code,
				reason: message,
				retryable,
			});
		}
	});

	it("accepts provider plain text but not arbitrary internal exceptions", () => {
		expect(normalizeProviderFailure(model, "Unknown vendor restriction", "response")?.reason).toBe(
			"Unknown vendor restriction",
		);
		for (const value of [
			new TypeError("private path"),
			new Error("database failed"),
			"plain internal error",
			"500: {broken",
			'400: {"debug":"private","error":"unrecognized envelope"}',
			"503: <html>secret</html>",
		]) {
			expect(normalizeProviderFailure(model, value)).toBeUndefined();
		}
		expect(
			normalizeProviderFailure(model, new Error("fetch failed", { cause: { code: "ECONNRESET" } })),
		).toMatchObject({ reason: "Could not connect to the model service", retryable: true });
		expect(normalizeProviderFailure(model, Object.assign(new Error("private"), { code: "ETIMEDOUT" }))).toMatchObject(
			{ reason: "The model service request timed out", retryable: true },
		);
	});

	it("redacts credentials and stack frames without losing parameter limits", () => {
		const result = normalizeProviderFailure(
			model,
			"max_tokens=8192 Bearer secret-token api_key=private sk-private https://user:pass@example.com/path?token=secret\u0000\n at internal (/private/file.ts:1)",
			"response",
		)!;
		expect(result.reason).toContain("max_tokens=8192");
		for (const secret of ["secret-token", "private", "user:pass", "token=secret", "internal"])
			expect(result.reason).not.toContain(secret);
		expect(normalizeProviderFailure(model, "x".repeat(3000), "response")?.reason).toHaveLength(2000);
	});

	it("keeps diagnostic status and only exposes localized presentation copies", () => {
		const raw = fauxAssistantMessage("", { stopReason: "error", errorMessage: '403: {"message":"Region blocked"}' });
		raw.diagnostics = [
			{
				type: "pi_messages_response_failure",
				timestamp: 1,
				details: { body: '{"message":"Region blocked"}', headers: "private" },
			},
		];
		const annotated = annotateProviderFailure(model, raw);
		expect(annotated.providerFailure?.upstreamStatus).toBe(403);
		expect(annotated.errorMessage).toBe(raw.errorMessage);
		for (const locale of ["zh-CN", "en-US"] as const) {
			const projected = localizePublicValue({ type: "agent_end", messages: [annotated] }, locale);
			expect(JSON.stringify(projected)).toContain("Region blocked (HTTP 403)");
			expect(JSON.stringify(projected)).not.toMatch(/diagnostics|providerFailure|errorMessageDescriptor|private/);
		}
	});

	it("handles synchronous throws independently and logs the original cause", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const original = Object.assign(new Error("max_tokens too large", { cause: new Error("original cause") }), {
				status: 400,
			});
			const result = await providerFailureStream(model, () => {
				throw original;
			}).result();
			expect(result.errorMessage).toBe("max_tokens too large");
			expect(result).toMatchObject({ providerFailure: { retryable: false, upstreamStatus: 400 } });
			expect(log).toHaveBeenCalledWith(
				"SSH Agent failure",
				expect.objectContaining({
					errorId: expect.any(String),
					error: expect.objectContaining({
						message: original.message,
						cause: expect.objectContaining({ message: "original cause" }),
					}),
				}),
			);
		} finally {
			log.mockRestore();
		}
	});

	it("preserves partial content and turns iteration failures into terminal errors", async () => {
		const input = createAssistantMessageEventStream();
		const partial = fauxAssistantMessage("already streamed");
		input.push({ type: "start", partial });
		input.end();
		const result = await providerFailureStream(model, () => input).result();
		expect(result.content).toEqual(partial.content);
		expect(result.stopReason).toBe("error");
		expect(result).not.toHaveProperty("providerFailure");
	});

	it("does not classify cancelled requests as provider failures", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await providerFailureStream(
			model,
			() => {
				throw Object.assign(new Error("aborted"), { status: 503 });
			},
			controller.signal,
		).result();
		expect(result.stopReason).toBe("aborted");
		expect(result).not.toHaveProperty("providerFailure");
	});

	it("normalizes thrown iterator errors after partial output without changing normal events", async () => {
		const input = createAssistantMessageEventStream();
		const partial = fauxAssistantMessage("partial output");
		vi.spyOn(input, Symbol.asyncIterator).mockImplementation(async function* () {
			yield { type: "start" as const, partial };
			throw Object.assign(new Error("upstream disconnected"), { status: 503 });
		});
		const stream = providerFailureStream(model, () => input);
		const events = [];
		for await (const event of stream) events.push(event);
		expect(events[0]).toEqual({ type: "start", partial });
		expect(events[1]).toMatchObject({
			type: "error",
			error: { content: partial.content, providerFailure: { retryable: true } },
		});
	});

	it("projects nested message_update errors and leaves old failures generic", () => {
		const raw = fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient credits" });
		const message = annotateProviderFailure(model, raw);
		const projected = localizePublicValue({ assistantMessageEvent: { type: "error", error: message } }, "zh-CN");
		expect(JSON.stringify(projected)).toContain("模型请求失败：insufficient credits");
		expect(JSON.stringify(projected)).not.toContain("providerFailure");
		expect(JSON.stringify(localizePublicValue(raw, "zh-CN"))).not.toContain("insufficient credits");
		expect(raw).not.toHaveProperty("errorMessageDescriptor");
	});
});
