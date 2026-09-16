import {
	type CredentialStore,
	createModels,
	fauxProvider,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";

export function createTestLlmModels(credentials: CredentialStore): MutableModels {
	const models = createModels({ credentials });
	models.setProvider(
		provider("anthropic", "Anthropic", "claude-sonnet-test", "Claude Sonnet Test", "https://api.anthropic.test"),
	);
	models.setProvider(provider("openai", "OpenAI", "gpt-test", "GPT Test"));
	return models;
}

function provider(providerId: string, name: string, modelId: string, modelName: string, baseUrl?: string): Provider {
	const faux = fauxProvider({
		api: "faux",
		provider: providerId,
		models: [
			{
				id: modelId,
				name: modelName,
				reasoning: true,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	});
	return {
		...faux.provider,
		name,
		baseUrl,
		auth: {
			apiKey: {
				name: `${name} API key`,
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
				}),
				resolve: async ({ credential }) =>
					credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
			},
		},
	};
}
