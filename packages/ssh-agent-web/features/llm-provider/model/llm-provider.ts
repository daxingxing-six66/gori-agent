export type LlmProviderCredentialType = "api_key" | "oauth";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmProviderCredential {
	providerId: string;
	type: LlmProviderCredentialType;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface LlmProvider {
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
	input: Array<"text" | "image">;
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

interface CustomLlmProviderWriteFields {
	name: string;
	baseUrl: string;
	api: CustomLlmProviderApi;
	authMode: CustomLlmProviderAuthMode;
	compat: CustomLlmProviderCompat;
	models: CustomLlmModel[];
}

export interface CreateCustomLlmProviderCredential {
	type: "api_key";
	apiKey: string;
}

export interface CreateCustomLlmProviderInput extends CustomLlmProviderWriteFields {
	id: string;
	credential?: CreateCustomLlmProviderCredential;
}

export interface UpdateCustomLlmProviderInput extends CustomLlmProviderWriteFields {
	expectedRevision: number;
}

export interface CustomLlmProviderList {
	providers: CustomLlmProvider[];
}

export interface LlmModel {
	id: string;
	providerId: string;
	name: string;
	api: string;
	reasoning: boolean;
	supportedThinkingLevels: ThinkingLevel[];
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
}

export function thinkingLevelForModel(model: LlmModel, preferred: ThinkingLevel): ThinkingLevel {
	if (model.supportedThinkingLevels.includes(preferred)) return preferred;
	if (model.supportedThinkingLevels.includes("off")) return "off";
	return model.supportedThinkingLevels[0] ?? "off";
}

export interface LlmProviderList {
	providers: LlmProvider[];
}

export interface LlmProviderCredentialList {
	credentials: LlmProviderCredential[];
}

export interface LlmProviderModels {
	providerId: string;
	models: LlmModel[];
}

export function deriveLlmProviderState(providers: readonly LlmProvider[]) {
	return {
		credentialProviders: providers.filter((provider) => provider.credential !== null),
		configurableProviders: providers.filter((provider) => provider.credential === null),
		modelProviders: providers.filter((provider) => provider.configured),
	};
}
