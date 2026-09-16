import { ManagementError } from "../domain/errors.ts";
import {
	type CreateCustomLlmProviderInput,
	CUSTOM_LLM_PROVIDER_APIS,
	type CustomLlmModel,
	type CustomLlmModelInput,
	type CustomLlmProvider,
	type CustomLlmProviderApi,
	type CustomLlmProviderCompat,
} from "../domain/llm-provider.ts";

export function buildCustomLlmProvider(
	input: CreateCustomLlmProviderInput,
	revision: number,
	createdAt: number,
	updatedAt: number,
): CustomLlmProvider {
	const id = normalizeText(input.id, "id", 128);
	if (!/^custom-[a-z0-9][a-z0-9._-]*$/.test(id)) {
		throw new ManagementError(
			"validation_error",
			"id must start with custom- and contain only lowercase letters, numbers, dots, underscores, and hyphens",
			"id",
		);
	}
	const name = normalizeText(input.name, "name", 256);
	const baseUrl = normalizeBaseUrl(input.baseUrl);
	if (!CUSTOM_LLM_PROVIDER_APIS.includes(input.api)) {
		throw new ManagementError("validation_error", "api is not supported", "api");
	}
	if (input.authMode !== "api_key" && input.authMode !== "none") {
		throw new ManagementError("validation_error", "authMode must be api_key or none", "authMode");
	}
	const compat = normalizeCompat(input.api, input.compat ?? {});
	const modelIds = new Set<string>();
	const models = input.models.map((model, index) => {
		const normalized = normalizeModel(model, index);
		if (modelIds.has(normalized.id)) {
			throw new ManagementError("validation_error", `Duplicate model id: ${normalized.id}`, `models[${index}].id`);
		}
		modelIds.add(normalized.id);
		return normalized;
	});
	return {
		id,
		name,
		baseUrl,
		api: input.api,
		authMode: input.authMode,
		compat,
		models,
		revision,
		createdAt,
		updatedAt,
	};
}

function normalizeModel(input: CustomLlmModelInput, index: number): CustomLlmModel {
	const field = `models[${index}]`;
	const id = normalizeText(input.id, `${field}.id`, 256);
	const name = normalizeText(input.name, `${field}.name`, 256);
	const contextWindow = positiveInteger(input.contextWindow, `${field}.contextWindow`);
	const maxTokens = positiveInteger(input.maxTokens, `${field}.maxTokens`);
	if (maxTokens > contextWindow) {
		throw new ManagementError("validation_error", "maxTokens must not exceed contextWindow", `${field}.maxTokens`);
	}
	const modelInput = input.input ?? ["text"];
	if (modelInput.length === 0 || modelInput.some((entry) => entry !== "text" && entry !== "image")) {
		throw new ManagementError("validation_error", "input must contain text and/or image", `${field}.input`);
	}
	const cost = input.cost ?? {};
	return {
		id,
		name,
		reasoning: input.reasoning ?? false,
		input: [...new Set(modelInput)],
		cost: {
			input: nonNegativeNumber(cost.input ?? 0, `${field}.cost.input`),
			output: nonNegativeNumber(cost.output ?? 0, `${field}.cost.output`),
			cacheRead: nonNegativeNumber(cost.cacheRead ?? 0, `${field}.cost.cacheRead`),
			cacheWrite: nonNegativeNumber(cost.cacheWrite ?? 0, `${field}.cost.cacheWrite`),
		},
		contextWindow,
		maxTokens,
	};
}

function normalizeCompat(api: CustomLlmProviderApi, compat: CustomLlmProviderCompat): CustomLlmProviderCompat {
	const allowed: Record<CustomLlmProviderApi, readonly (keyof CustomLlmProviderCompat)[]> = {
		"openai-completions": [
			"supportsDeveloperRole",
			"supportsReasoningEffort",
			"supportsUsageInStreaming",
			"maxTokensField",
		],
		"openai-responses": ["supportsDeveloperRole", "supportsStrictMode"],
		"anthropic-messages": ["supportsTemperature", "supportsStrictTools", "forceAdaptiveThinking"],
		"google-generative-ai": [],
	};
	for (const [key, value] of Object.entries(compat)) {
		if (!allowed[api].includes(key as keyof CustomLlmProviderCompat)) {
			throw new ManagementError("validation_error", `compat.${key} is not valid for ${api}`, `compat.${key}`);
		}
		if (key === "maxTokensField") {
			if (value !== "max_tokens" && value !== "max_completion_tokens") {
				throw new ManagementError("validation_error", "maxTokensField is invalid", "compat.maxTokensField");
			}
		} else if (typeof value !== "boolean") {
			throw new ManagementError("validation_error", `compat.${key} must be a boolean`, `compat.${key}`);
		}
	}
	return { ...compat };
}

function normalizeText(value: string, field: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized) throw new ManagementError("validation_error", `${field} must not be empty`, field);
	if (normalized.length > maximum) {
		throw new ManagementError("validation_error", `${field} must not exceed ${maximum} characters`, field);
	}
	return normalized;
}

function normalizeBaseUrl(value: string): string {
	const normalized = normalizeText(value, "baseUrl", 2048);
	let url: URL;
	try {
		url = new URL(normalized);
	} catch {
		throw new ManagementError("validation_error", "baseUrl must be a valid URL", "baseUrl");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ManagementError("validation_error", "baseUrl must use http or https", "baseUrl");
	}
	return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ManagementError("validation_error", `${field} must be a positive integer`, field);
	}
	return value;
}

function nonNegativeNumber(value: number, field: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new ManagementError("validation_error", `${field} must be a non-negative number`, field);
	}
	return value;
}
