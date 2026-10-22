import { describe, expect, it } from "vitest";
import { stream as streamCompletions } from "../../ai/src/api/openai-completions.ts";
import { stream as streamResponses } from "../../ai/src/api/openai-responses.ts";
import { stream as streamMistral } from "../../ai/src/api/mistral-conversations.ts";
import type { Model, Usage } from "../../ai/src/types.ts";

const common = { id: "cache-test", name: "Cache Test", provider: "cache-test", baseUrl: "https://cache-test.invalid/v1",
	reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };

function response(events: Record<string, unknown>[]): Response {
	return new Response(events.map(event => `${typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } });
}

async function completions(usage?: Record<string, unknown>): Promise<Usage> {
	const model: Model<"openai-completions"> = { ...common, api: "openai-completions" };
	return (await streamCompletions(model, context, { apiKey: "test", cacheRetention: "none", fetch: async () => response([
		{ id: "completion", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) },
	]) }).result()).usage;
}

async function responses(usage?: Record<string, unknown>): Promise<Usage> {
	const model: Model<"openai-responses"> = { ...common, api: "openai-responses" };
	return (await streamResponses(model, context, { apiKey: "test", cacheRetention: "none", fetch: async () => response([
		{ type: "response.completed", response: { id: "response", status: "completed", output: [], ...(usage ? { usage } : {}) } },
	]) }).result()).usage;
}

async function mistral(usage?: Record<string, unknown>): Promise<Usage> {
	const model: Model<"mistral-conversations"> = { ...common, api: "mistral-conversations" };
	return (await streamMistral(model, context, { apiKey: "test", cacheRetention: "none", fetch: async () => response([
		{ id: "mistral", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) },
	]) }).result()).usage;
}

const adapters = [
	{ name: "Completions", call: completions, usage: (input: unknown, cached: unknown) => ({ prompt_tokens: input, completion_tokens: 200, prompt_tokens_details: { cached_tokens: cached } }) },
	{ name: "Responses", call: responses, usage: (input: unknown, cached: unknown) => ({ input_tokens: input, output_tokens: 200, total_tokens: 300, input_tokens_details: { cached_tokens: cached } }) },
	{ name: "Mistral", call: mistral, usage: (input: unknown, cached: unknown) => ({ prompt_tokens: input, completion_tokens: 200, prompt_tokens_details: { cached_tokens: cached } }) },
];

describe.each(adapters)("$name reported cache usage", adapter => {
	it.each([90, 0])("preserves explicit %i cache hits and the API's complete input separately from normalized usage", async cached => {
		const usage = await adapter.call(adapter.usage(100, cached));
		expect(usage.cacheReadDetails).toEqual({ inputTokens: 100, cachedTokens: cached });
		expect(usage.input).toBe(100 - cached);
		expect(usage.output).toBe(200);
	});
	it.each([[100, undefined], [undefined, 90], [100, -1], [100, 101], [100, 1.5], [100, "90"], [Infinity, 0], [Number.MAX_SAFE_INTEGER + 1, 0]])(
		"does not manufacture cache facts from missing or invalid API fields (%s, %s)", async (input, cached) => {
			expect((await adapter.call(adapter.usage(input, cached))).cacheReadDetails).toBeUndefined();
		},
	);
	it("distinguishes zero input from absent usage", async () => {
		expect((await adapter.call(adapter.usage(0, 0))).cacheReadDetails).toEqual({ inputTokens: 0, cachedTokens: 0 });
		expect((await adapter.call()).cacheReadDetails).toBeUndefined();
	});
});

describe("compatible usage field mappings", () => {
	it.each(["prompt_cache_hit_tokens", "cached_tokens"])("preserves Completions %s without inferring it from cost", async field => {
		const usage = await completions({ prompt_tokens: 100, completion_tokens: 200, [field]: 90 });
		expect(usage.cacheReadDetails).toEqual({ inputTokens: 100, cachedTokens: 90 });
	});
	it.each([completions, responses])("retains total input including cache writes", async call => {
		const usage = await call({ prompt_tokens: 100, input_tokens: 100, completion_tokens: 200, output_tokens: 200,
			prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 }, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 } });
		expect(usage).toMatchObject({ input: 30, cacheRead: 40, cacheWrite: 30, cacheReadDetails: { inputTokens: 100, cachedTokens: 40 } });
	});
	it("keeps Mistral's legacy clamping separate from authoritative API facts", async () => {
		const usage = await mistral({ prompt_tokens: 100, completion_tokens: 200, num_cached_tokens: 110 });
		expect(usage.cacheRead).toBe(100);
		expect(usage.cacheReadDetails).toBeUndefined();
	});
});
