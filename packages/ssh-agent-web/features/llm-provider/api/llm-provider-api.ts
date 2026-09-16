import type {
	CreateCustomLlmProviderInput,
	CustomLlmProvider,
	CustomLlmProviderList,
	LlmModel,
	LlmProviderCredential,
	LlmProviderCredentialList,
	LlmProviderList,
	LlmProviderModels,
	UpdateCustomLlmProviderInput,
} from "@/features/llm-provider/model/llm-provider";
import { apiRequest } from "@/shared/api/client";

export const llmProviderApi = {
	listProviders: (signal?: AbortSignal) => apiRequest<LlmProviderList>("/api/llm/providers", { signal }),
	listModels: (providerId: string, signal?: AbortSignal) =>
		apiRequest<LlmProviderModels>(`/api/llm/providers/${encodeURIComponent(providerId)}/models`, { signal }),
	listCredentials: () => apiRequest<LlmProviderCredentialList>("/api/llm/provider-credentials"),
	getCredential: (providerId: string) =>
		apiRequest<LlmProviderCredential>(`/api/llm/providers/${encodeURIComponent(providerId)}/credential`),
	configureCredential: (providerId: string, apiKey: string, expectedRevision?: number) =>
		apiRequest<LlmProviderCredential>(`/api/llm/providers/${encodeURIComponent(providerId)}/credential`, {
			method: "PUT",
			body: {
				type: "api_key",
				apiKey,
				...(expectedRevision === undefined ? {} : { expectedRevision }),
			},
		}),
	deleteCredential: (providerId: string, expectedRevision: number) =>
		apiRequest<void>(
			`/api/llm/providers/${encodeURIComponent(providerId)}/credential?expectedRevision=${expectedRevision}`,
			{ method: "DELETE" },
		),
	listCustomProviders: (signal?: AbortSignal) =>
		apiRequest<CustomLlmProviderList>("/api/llm/custom-providers", { signal }),
	createCustomProvider: (input: CreateCustomLlmProviderInput) =>
		apiRequest<CustomLlmProvider>("/api/llm/custom-providers", { method: "POST", body: input }),
	getCustomProvider: (providerId: string, signal?: AbortSignal) =>
		apiRequest<CustomLlmProvider>(`/api/llm/custom-providers/${encodeURIComponent(providerId)}`, { signal }),
	updateCustomProvider: (providerId: string, input: UpdateCustomLlmProviderInput) =>
		apiRequest<CustomLlmProvider>(`/api/llm/custom-providers/${encodeURIComponent(providerId)}`, {
			method: "PUT",
			body: input,
		}),
	deleteCustomProvider: (providerId: string, expectedRevision: number) =>
		apiRequest<void>(
			`/api/llm/custom-providers/${encodeURIComponent(providerId)}?expectedRevision=${expectedRevision}`,
			{ method: "DELETE" },
		),
};

export async function resolveConfiguredModel(
	selection: { providerId: string; modelId: string },
	signal?: AbortSignal,
): Promise<LlmModel | null> {
	const { providers } = await llmProviderApi.listProviders(signal);
	if (!providers.some((provider) => provider.id === selection.providerId && provider.configured)) return null;
	const { models } = await llmProviderApi.listModels(selection.providerId, signal);
	return models.find((model) => model.id === selection.modelId) ?? null;
}
