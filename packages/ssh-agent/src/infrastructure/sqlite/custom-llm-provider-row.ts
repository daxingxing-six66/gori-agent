import { buildCustomLlmProvider } from "../../application/custom-llm-provider-factory.ts";
import {
	CUSTOM_LLM_PROVIDER_APIS,
	type CustomLlmModelInput,
	type CustomLlmProvider,
	type CustomLlmProviderApi,
	type CustomLlmProviderAuthMode,
	type CustomLlmProviderCompat,
} from "../../domain/llm-provider.ts";

export function customLlmProviderFromRow(row: Record<string, unknown>): CustomLlmProvider {
	const id = storedString(row.id, "unknown", "id");
	try {
		const input = {
			id,
			name: storedString(row.name, id, "name"),
			baseUrl: storedString(row.base_url, id, "base_url"),
			api: storedApi(row.api, id),
			authMode: storedAuthMode(row.auth_mode, id),
			compat: storedCompat(parseJson(row.compat_json, id, "compat_json"), id),
			models: storedModels(parseJson(row.models_json, id, "models_json"), id),
		};
		const provider = buildCustomLlmProvider(
			input,
			storedPositiveInteger(row.revision, id, "revision"),
			storedNonNegativeInteger(row.created_at, id, "created_at"),
			storedNonNegativeInteger(row.updated_at, id, "updated_at"),
		);
		if (provider.id !== input.id || provider.name !== input.name || provider.baseUrl !== input.baseUrl) {
			throw storedError(id, "stored text fields are not normalized");
		}
		return provider;
	} catch (error) {
		if (error instanceof StoredCustomLlmProviderError) throw error;
		throw storedError(id, "stored aggregate is invalid", error);
	}
}

class StoredCustomLlmProviderError extends Error {}

function parseJson(value: unknown, providerId: string, field: string): unknown {
	if (typeof value !== "string") throw storedError(providerId, `${field} must be text`);
	try {
		return JSON.parse(value) as unknown;
	} catch (error) {
		throw storedError(providerId, `${field} is not valid JSON`, error);
	}
}

function storedCompat(value: unknown, providerId: string): CustomLlmProviderCompat {
	const source = storedObject(value, providerId, "compat_json");
	storedExactKeys(
		source,
		[
			"supportsDeveloperRole",
			"supportsReasoningEffort",
			"supportsUsageInStreaming",
			"maxTokensField",
			"supportsStrictMode",
			"supportsTemperature",
			"supportsStrictTools",
			"forceAdaptiveThinking",
		],
		providerId,
		"compat_json",
	);
	const result: CustomLlmProviderCompat = {};
	for (const key of [
		"supportsDeveloperRole",
		"supportsReasoningEffort",
		"supportsUsageInStreaming",
		"supportsStrictMode",
		"supportsTemperature",
		"supportsStrictTools",
		"forceAdaptiveThinking",
	] as const) {
		const entry = source[key];
		if (entry !== undefined) {
			if (typeof entry !== "boolean") throw storedError(providerId, `compat_json.${key} must be boolean`);
			result[key] = entry;
		}
	}
	const maxTokensField = source.maxTokensField;
	if (maxTokensField !== undefined) {
		if (maxTokensField !== "max_tokens" && maxTokensField !== "max_completion_tokens") {
			throw storedError(providerId, "compat_json.maxTokensField is invalid");
		}
		result.maxTokensField = maxTokensField;
	}
	return result;
}

function storedModels(value: unknown, providerId: string): CustomLlmModelInput[] {
	if (!Array.isArray(value)) throw storedError(providerId, "models_json must be an array");
	return value.map((entry, index) => storedModel(entry, providerId, index));
}

function storedModel(value: unknown, providerId: string, index: number): CustomLlmModelInput {
	const field = `models_json[${index}]`;
	const source = storedObject(value, providerId, field);
	storedExactKeys(
		source,
		["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens"],
		providerId,
		field,
	);
	if (typeof source.reasoning !== "boolean") throw storedError(providerId, `${field}.reasoning must be boolean`);
	if (!Array.isArray(source.input) || source.input.length === 0) {
		throw storedError(providerId, `${field}.input must be a non-empty array`);
	}
	const input = source.input.map((entry, inputIndex) => {
		if (entry !== "text" && entry !== "image") {
			throw storedError(providerId, `${field}.input[${inputIndex}] is invalid`);
		}
		return entry;
	});
	if (new Set(input).size !== input.length) throw storedError(providerId, `${field}.input contains duplicates`);
	const cost = storedObject(source.cost, providerId, `${field}.cost`);
	storedExactKeys(cost, ["input", "output", "cacheRead", "cacheWrite"], providerId, `${field}.cost`);
	return {
		id: storedString(source.id, providerId, `${field}.id`),
		name: storedString(source.name, providerId, `${field}.name`),
		reasoning: source.reasoning,
		input,
		cost: {
			input: storedNonNegativeNumber(cost.input, providerId, `${field}.cost.input`),
			output: storedNonNegativeNumber(cost.output, providerId, `${field}.cost.output`),
			cacheRead: storedNonNegativeNumber(cost.cacheRead, providerId, `${field}.cost.cacheRead`),
			cacheWrite: storedNonNegativeNumber(cost.cacheWrite, providerId, `${field}.cost.cacheWrite`),
		},
		contextWindow: storedPositiveInteger(source.contextWindow, providerId, `${field}.contextWindow`),
		maxTokens: storedPositiveInteger(source.maxTokens, providerId, `${field}.maxTokens`),
	};
}

function storedApi(value: unknown, providerId: string): CustomLlmProviderApi {
	if (typeof value !== "string" || !CUSTOM_LLM_PROVIDER_APIS.includes(value as CustomLlmProviderApi)) {
		throw storedError(providerId, "api is invalid");
	}
	return value as CustomLlmProviderApi;
}

function storedAuthMode(value: unknown, providerId: string): CustomLlmProviderAuthMode {
	if (value !== "api_key" && value !== "none") throw storedError(providerId, "auth_mode is invalid");
	return value;
}

function storedObject(value: unknown, providerId: string, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw storedError(providerId, `${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function storedExactKeys(
	source: Record<string, unknown>,
	allowed: readonly string[],
	providerId: string,
	field: string,
): void {
	const allowedSet = new Set(allowed);
	const unexpected = Object.keys(source).find((key) => !allowedSet.has(key));
	if (unexpected !== undefined) throw storedError(providerId, `${field}.${unexpected} is unexpected`);
}

function storedString(value: unknown, providerId: string, field: string): string {
	if (typeof value !== "string") throw storedError(providerId, `${field} must be text`);
	return value;
}

function storedPositiveInteger(value: unknown, providerId: string, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw storedError(providerId, `${field} must be a positive integer`);
	}
	return value;
}

function storedNonNegativeInteger(value: unknown, providerId: string, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw storedError(providerId, `${field} must be a non-negative integer`);
	}
	return value;
}

function storedNonNegativeNumber(value: unknown, providerId: string, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw storedError(providerId, `${field} must be a non-negative number`);
	}
	return value;
}

function storedError(providerId: string, detail: string, cause?: unknown): StoredCustomLlmProviderError {
	return new StoredCustomLlmProviderError(`Invalid stored custom LLM Provider "${providerId}": ${detail}`, {
		...(cause === undefined ? {} : { cause }),
	});
}
