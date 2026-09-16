import type { CustomLlmProvider } from "../../domain/llm-provider.ts";

export interface CustomLlmProviderRepository {
	list(): readonly CustomLlmProvider[];
	findById(providerId: string): CustomLlmProvider | undefined;
	insert(provider: CustomLlmProvider): void;
	update(provider: CustomLlmProvider, expectedRevision: number): void;
	delete(providerId: string, expectedRevision: number): void;
}
