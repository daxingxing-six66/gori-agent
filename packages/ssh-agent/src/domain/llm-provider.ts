import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type LlmProviderCredentialType = "api_key" | "oauth";

export interface LlmProviderCredential {
	providerId: string;
	type: LlmProviderCredentialType;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface ConfigureLlmProviderApiKeyInput {
	providerId: string;
	apiKey?: string;
	environment?: Record<string, string>;
	expectedRevision?: number;
}

export interface DeleteLlmProviderCredentialInput {
	providerId: string;
	expectedRevision: number;
}

export interface LlmProviderDefinition {
	id: string;
	name: string;
	custom: boolean;
	baseUrl: string | null;
	auth: {
		apiKey: boolean;
		oauth: boolean;
	};
	configured: boolean;
	credential: LlmProviderCredential | null;
	modelCount: number;
}

export const CUSTOM_LLM_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export type CustomLlmProviderApi = (typeof CUSTOM_LLM_PROVIDER_APIS)[number];
export type CustomLlmProviderAuthMode = "api_key" | "none";

export interface CustomLlmProviderCompat {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	supportsUsageInStreaming?: boolean;
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	supportsStrictMode?: boolean;
	supportsTemperature?: boolean;
	supportsStrictTools?: boolean;
	forceAdaptiveThinking?: boolean;
}

export interface CustomLlmModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CustomLlmModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: CustomLlmModelCost;
	contextWindow: number;
	maxTokens: number;
}

export interface CustomLlmProvider {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomLlmProviderApi;
	authMode: CustomLlmProviderAuthMode;
	compat: CustomLlmProviderCompat;
	models: CustomLlmModel[];
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface CustomLlmModelInput {
	id: string;
	name: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: Partial<CustomLlmModelCost>;
	contextWindow: number;
	maxTokens: number;
}

export interface CreateCustomLlmProviderCredentialInput {
	type: "api_key";
	apiKey: string;
}

export interface CreateCustomLlmProviderInput {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomLlmProviderApi;
	authMode: CustomLlmProviderAuthMode;
	compat?: CustomLlmProviderCompat;
	models: CustomLlmModelInput[];
	credential?: CreateCustomLlmProviderCredentialInput;
}

export interface UpdateCustomLlmProviderInput extends Omit<CreateCustomLlmProviderInput, "credential" | "id"> {
	providerId: string;
	expectedRevision: number;
}

export interface DeleteCustomLlmProviderInput {
	providerId: string;
	expectedRevision: number;
}

export interface LlmModelDefinition {
	id: string;
	providerId: string;
	name: string;
	api: string;
	reasoning: boolean;
	supportedThinkingLevels: readonly ModelThinkingLevel[];
	input: readonly ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

export interface LlmProviderModels {
	providerId: string;
	models: LlmModelDefinition[];
}
