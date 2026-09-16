import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { CustomLlmProvider, CustomLlmProviderApi } from "../../domain/llm-provider.ts";

export interface CustomLlmProviderRuntime {
	register(provider: CustomLlmProvider): void;
	remove(providerId: string): void;
}

export class PiCustomLlmProviderRuntime implements CustomLlmProviderRuntime {
	readonly #models: MutableModels;

	constructor(models: MutableModels) {
		this.#models = models;
	}

	register(provider: CustomLlmProvider): void {
		this.#models.setProvider(toPiProvider(provider));
	}

	remove(providerId: string): void {
		this.#models.deleteProvider(providerId);
	}
}

function toPiProvider(provider: CustomLlmProvider): Provider {
	const api = {
		"openai-completions": openAICompletionsApi(),
		"openai-responses": openAIResponsesApi(),
		"anthropic-messages": anthropicMessagesApi(),
		"google-generative-ai": googleGenerativeAIApi(),
	};
	return createProvider<CustomLlmProviderApi>({
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl,
		auth: {
			apiKey:
				provider.authMode === "api_key"
					? {
							name: `${provider.name} API key`,
							resolve: async ({ credential, signal }) => {
								signal.throwIfAborted();
								return credential?.key
									? { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" }
									: undefined;
							},
						}
					: {
							name: "No authentication",
							check: async ({ signal }) => {
								signal.throwIfAborted();
								return { type: "api_key", source: "no authentication" };
							},
							resolve: async ({ signal }) => {
								signal.throwIfAborted();
								return { auth: {}, source: "no authentication" };
							},
						},
		},
		models: provider.models.map((model) => ({
			...model,
			provider: provider.id,
			api: provider.api,
			baseUrl: provider.baseUrl,
			compat: provider.compat,
		})) as Model<CustomLlmProviderApi>[],
		api,
	});
}
