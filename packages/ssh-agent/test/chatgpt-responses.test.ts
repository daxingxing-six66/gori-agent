import { getSupportedThinkingLevels, Type, type Context, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { CHATGPT_PROVIDER_ID, CHATGPT_RESOURCE } from "../src/domain/chatgpt.ts";
import { parseChatGptModels } from "../src/infrastructure/chatgpt/chatgpt-provider.ts";
import { chatGptResponsesApi, prepareChatGptPayload } from "../src/infrastructure/chatgpt/chatgpt-responses.ts";
import { normalizeProviderFailure, providerFailureDescriptor } from "../src/application/provider-failure-classification.ts";
import { terminalInteractionDefinition } from "../src/application/tools/terminal-interaction-tool.ts";

// Exercise the source adapter and real SDK/SSE parser, rather than an older installed build.
vi.mock("@earendil-works/pi-ai/api/openai-responses.lazy", async () => {
	const source = await import("../../ai/src/api/openai-responses.ts");
	return { openAIResponsesApi: () => source };
});

const model: Model<"openai-responses"> = {
	id: "test-gpt", name: "Test GPT", api: "openai-responses", provider: CHATGPT_PROVIDER_ID,
	baseUrl: CHATGPT_RESOURCE, reasoning: true, input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function streamResponse(events: Record<string, unknown>[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function completion(output: unknown[]) {
	return { type: "response.completed", response: { id: "resp_test", status: "completed", output,
		usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } };
}

describe("ChatGPT Responses compatibility", () => {
	it.each(["baseline", "discovered"])("sends explicit non-strict function tools for a %s model while retaining optional Terminal fields", async (source) => {
		const [discovered] = parseChatGptModels({ models: [{ slug: model.id, display_name: model.name, visibility: "list" }] },
			source === "baseline" ? [{ ...model, compat: { supportsStrictMode: false } }] : []);
		const payloads: Record<string, unknown>[] = [];
		const result = await chatGptResponsesApi().streamSimple(discovered!, {
			messages: [{ role: "user", content: "Observe the terminal", timestamp: 1 }], tools: [terminalInteractionDefinition],
		}, {
			apiKey: "dummy", fetch: async (_input, init) => {
				payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return streamResponse([completion([])]);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(payloads).toHaveLength(1);
		expect(payloads[0]!.tools).toEqual([{ type: "namespace", name: "gori", description: expect.any(String), tools: [
			expect.objectContaining({ type: "function", name: "terminal_interaction", strict: false, parameters: expect.objectContaining({
				type: "object", additionalProperties: false, required: ["action", "expectation"],
				properties: expect.objectContaining({ input: expect.objectContaining({ type: "string", minLength: 1 }), key: expect.objectContaining({ const: "CTRL_C" }) }),
			}) }),
		] }]);
	});

	it("completes a namespaced tool round trip while preserving chronological instructions, images and tool results", async () => {
		const payloads: Record<string, unknown>[] = [];
		const functionCall = { type: "function_call", id: "fc_test", call_id: "call_test", name: "remote_server_call", namespace: "gori", arguments: '{"command":"pwd"}', status: "completed" };
		const message = { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Completed", annotations: [] }] };
		const fakeFetch: typeof fetch = async (input, init) => {
			expect(String(input)).toBe(`${CHATGPT_RESOURCE}/responses`);
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-access");
			payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			if (payloads.length === 1) return streamResponse([
				{ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
				{ type: "response.output_item.added", output_index: 0, item: { ...functionCall, arguments: "", status: "in_progress" } },
				{ type: "response.function_call_arguments.delta", output_index: 0, delta: functionCall.arguments },
				{ type: "response.output_item.done", output_index: 0, item: functionCall }, completion([functionCall]),
			]);
			return streamResponse([
				{ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
				{ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Completed" },
				{ type: "response.output_item.done", output_index: 0, item: message }, completion([message]),
			]);
		};
		const context: Context = {
			systemPrompt: "You are Gori.", messages: [
				{ role: "user", content: [{ type: "text", text: "Check the directory" }, { type: "image", mimeType: "image/png", data: "AAAA" }], timestamp: 1 },
				{ role: "system", content: [{ type: "text", text: "Runtime task instructions" }], timestamp: 2 },
			], tools: [{ name: "remote_server_call", description: "Run a command", parameters: Type.Object({ command: Type.String() }) }],
		};
		const api = chatGptResponsesApi();
		const options = { apiKey: "oauth-access", fetch: fakeFetch, temperature: 0.5, maxTokens: 1000,
			cacheRetention: "long" as const, reasoning: "medium" as const, sessionId: "test-session" };
		const first = await api.streamSimple(model, context, options).result();
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "remote_server_call", namespace: "gori", arguments: { command: "pwd" } }));
		const toolCall = first.content.find((block) => block.type === "toolCall")!;
		const second = await api.streamSimple(model, { ...context, messages: [...context.messages, first,
			{ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text: "/srv/gori" }], isError: false, timestamp: 3 },
		] }, options).result();
		expect(second.stopReason).toBe("stop");
		expect(second.content).toContainEqual(expect.objectContaining({ type: "text", text: "Completed" }));
		expect(second.usage.totalTokens).toBe(20);
		for (const payload of payloads) {
			expect(payload).toMatchObject({ stream: true, store: false, tools: [{ type: "namespace", name: "gori", tools: [expect.objectContaining({ type: "function", name: "remote_server_call" })] }] });
			expect(payload).not.toHaveProperty("temperature");
			expect(payload).not.toHaveProperty("max_output_tokens");
			expect(payload).not.toHaveProperty("prompt_cache_retention");
			expect(payload.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: "developer", content: [{ type: "input_text", text: "Runtime task instructions" }] })]));
		}
		expect(payloads[1]!.input).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "function_call", name: "remote_server_call", namespace: "gori" }),
			expect.objectContaining({ type: "function_call_output", output: "/srv/gori" }),
		]));
	});

	it("treats a usage failure after partial text as failure and offers the localized usage action", async () => {
		const api = chatGptResponsesApi();
		const fakeFetch: typeof fetch = async () => streamResponse([
			{ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Partial" },
			{ type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit" } } },
		]);
		const result = await api.streamSimple(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, { apiKey: "dummy", fetch: fakeFetch }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("subscription_sharing_usage_limit_exceeded");
		const failure = normalizeProviderFailure(model, result.errorMessage, "response")!;
		expect(providerFailureDescriptor(failure).key).toBe("provider.chatgpt_usage_limit");
	});

	it("rejects a stream without a completed terminal response", async () => {
		const result = await chatGptResponsesApi().streamSimple(model, { messages: [] }, {
			apiKey: "dummy", fetch: async () => streamResponse([{ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } }]),
		}).result();
		expect(result.stopReason).toBe("error");
	});

	it("enforces the restricted request contract after caller payload hooks", () => {
		const payload = prepareChatGptPayload({ model: "test", input: [], metadata: { secret: "omit" }, conversation: "omit", previous_response_id: "omit", background: true, store: true, stream: false });
		expect(payload).toEqual({ model: "test", input: [], store: false, stream: true });
		expect(() => prepareChatGptPayload({ input: [], tools: [{ type: "tool_search" }] })).toThrow("Unsupported tool");
	});

	it("uses only the account's discovered entitlements and conservative capabilities for unknown model slugs", () => {
		const models = parseChatGptModels({ models: [
			{ slug: "test-gpt", display_name: "Known", visibility: "list" },
			{ slug: "new-model", display_name: "New", visibility: "list" },
		] }, [model, { ...model, id: "not-entitled" }]);
		expect(models.map((entry) => entry.id)).toEqual(["test-gpt", "new-model"]);
		expect(models[0]).toMatchObject({ reasoning: true, input: ["text", "image"], contextWindow: 128_000 });
		expect(models[1]).toMatchObject({ reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096 });
	});

	it.each([
		{ id: "gpt-6.1-sol", canDisable: false },
		{ id: "gpt-6-astra", canDisable: false },
		{ id: "gpt-6-sol", canDisable: true },
		{ id: "gpt-6-luna", canDisable: true },
	])("uses documented model limits and reasoning efforts for $id without a bundled baseline", async ({ id, canDisable }) => {
		const [discovered] = parseChatGptModels({ models: [{ slug: id, display_name: id, visibility: "list" }] }, []);
		expect(discovered).toMatchObject({ reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000, input: ["text", "image"] });
		const levels = getSupportedThinkingLevels(discovered!);
		expect(levels).toEqual([...(canDisable ? ["off"] : []), "low", "medium", "high", "xhigh", "max"]);
		for (const reasoning of levels) {
			const payloads: Record<string, unknown>[] = [];
			const result = await chatGptResponsesApi().streamSimple(discovered!, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, {
				apiKey: "dummy", reasoning: reasoning === "off" ? undefined : reasoning,
				fetch: async (_input, init) => {
					payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
					return streamResponse([completion([])]);
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(payloads).toHaveLength(1);
			expect(payloads[0]).toMatchObject({ model: id, store: false, stream: true,
				reasoning: { effort: reasoning === "off" ? "none" : reasoning } });
		}
	});

	it("prefers a supplied baseline and does not infer capabilities from a GPT-6 prefix", () => {
		const baseline = { ...model, id: "gpt-6-sol", thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null } };
		const models = parseChatGptModels({ models: [
			{ slug: "gpt-6-sol", display_name: "Known", visibility: "list" },
			{ slug: "gpt-6-future-unknown", display_name: "Unknown", visibility: "list" },
		] }, [baseline]);
		expect(models[0]).toMatchObject({ contextWindow: baseline.contextWindow, maxTokens: baseline.maxTokens, input: baseline.input });
		expect(getSupportedThinkingLevels(models[0]!)).toEqual(["low", "medium", "high"]);
		expect(models[1]).toMatchObject({ contextWindow: 32_768, maxTokens: 4_096, input: ["text"] });
		expect(getSupportedThinkingLevels(models[1]!)).toEqual(["off"]);
	});
});
