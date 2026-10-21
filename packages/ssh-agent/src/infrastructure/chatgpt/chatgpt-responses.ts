import type { Model, OpenAIResponsesOptions, ProviderStreams, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { CHATGPT_RESOURCE } from "../../domain/chatgpt.ts";

const NAMESPACE = "gori";
const ALLOWED_FIELDS = new Set([
	"model", "input", "instructions", "tools", "tool_choice", "reasoning", "include", "prompt_cache_key", "parallel_tool_calls",
]);

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ChatGPT request");
	return value as Record<string, unknown>;
}

/** SIWC uses a restricted public Responses contract, independently of API-key/Codex providers. */
export function prepareChatGptPayload(payload: unknown): Record<string, unknown> {
	const source = record(payload);
	const result = Object.fromEntries(Object.entries(source).filter(([key]) => ALLOWED_FIELDS.has(key)));
	if (!Array.isArray(source.input)) throw new Error("ChatGPT requests require a complete input array");
	result.input = source.input.map((value) => {
		const item = record(value);
		// Preserve runtime instruction positions; SIWC accepts developer rather than system messages.
		if (item.role === "system") return { ...item, role: "developer" };
		if (item.type === "function_call" || item.type === "custom_tool_call") return { ...item, namespace: NAMESPACE };
		if (item.type === "tool_search_call" || item.type === "tool_search_output") throw new Error("ChatGPT plan usage does not support tool_search");
		return item;
	});
	if (Array.isArray(source.tools) && source.tools.length > 0) {
		const tools = source.tools.map((value) => {
			const tool = record(value);
			if (tool.type !== "function" && tool.type !== "custom") throw new Error("Unsupported tool on ChatGPT plan usage");
			return tool;
		});
		result.tools = [{ type: "namespace", name: NAMESPACE, description: "Tools executed by Gori on the user's behalf.", tools }];
	}
	if (result.tool_choice && typeof result.tool_choice === "object") {
		const choice = record(result.tool_choice);
		if (choice.type === "function" || choice.type === "custom") result.tool_choice = { ...choice, namespace: NAMESPACE };
	}
	return { ...result, store: false, stream: true };
}

function optionsForChatGpt<T extends OpenAIResponsesOptions | SimpleStreamOptions>(options: T | undefined): T {
	return { ...options, onPayload: async (payload: unknown, model: Model<"openai-responses">) => {
		const replacement = await options?.onPayload?.(payload, model);
		return prepareChatGptPayload(replacement ?? payload);
	} } as T;
}

export function chatGptResponsesApi(): ProviderStreams {
	const api = openAIResponsesApi();
	return {
		stream: (model, context, options) => api.stream({ ...model, baseUrl: CHATGPT_RESOURCE }, context, optionsForChatGpt(options)),
		streamSimple: (model, context, options) => api.streamSimple({ ...model, baseUrl: CHATGPT_RESOURCE }, context, optionsForChatGpt(options)),
	};
}
