import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import { ManagementError } from "../../domain/errors.ts";
import type { Clock } from "../../domain/ids.ts";
import type {
	ConfigureLlmProviderApiKeyInput,
	DeleteLlmProviderCredentialInput,
	LlmModelDefinition,
	LlmProviderCredential,
	LlmProviderDefinition,
	LlmProviderModels,
} from "../../domain/llm-provider.ts";
import type { LlmProviderCredentialStore } from "../repositories/llm-provider-credential-store.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import type { CustomLlmProviderService } from "./custom-llm-provider-service.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";
import { createApiKeyCredential } from "./llm-provider-api-key.ts";

export interface LlmProviderService {
	listProviders(): Promise<readonly LlmProviderDefinition[]>;
	listModels(providerId: string): Promise<LlmProviderModels>;
	listCredentials(): Promise<readonly LlmProviderCredential[]>;
	getCredential(providerId: string): Promise<LlmProviderCredential>;
	configureApiKey(input: ConfigureLlmProviderApiKeyInput): Promise<LlmProviderCredential>;
	deleteCredential(input: DeleteLlmProviderCredentialInput): Promise<void>;
}

export interface DefaultLlmProviderServiceOptions {
	models: Models;
	catalog: LlmModelCatalog;
	credentials: LlmProviderCredentialStore;
	clock: Clock;
	transactions: TransactionRunner;
	customProviders: Pick<CustomLlmProviderService, "find">;
}

export class DefaultLlmProviderService implements LlmProviderService {
	private readonly models: Models;
	private readonly catalog: LlmModelCatalog;
	private readonly credentials: LlmProviderCredentialStore;
	private readonly clock: Clock;
	private readonly transactions: TransactionRunner;
	private readonly customProviders: Pick<CustomLlmProviderService, "find">;

	constructor(options: DefaultLlmProviderServiceOptions) {
		this.models = options.models;
		this.catalog = options.catalog;
		this.credentials = options.credentials;
		this.clock = options.clock;
		this.transactions = options.transactions;
		this.customProviders = options.customProviders;
	}

	async listProviders(): Promise<readonly LlmProviderDefinition[]> {
		const metadata = new Map(
			(await this.credentials.listMetadata()).map((credential) => [credential.providerId, credential]),
		);
		const providers = await Promise.all(
			this.models.getProviders().map(async (provider): Promise<LlmProviderDefinition> => {
				const customProvider = this.customProviders.find(provider.id);
				return {
					id: provider.id,
					name: provider.name,
					custom: customProvider !== undefined,
					baseUrl: provider.baseUrl ?? null,
					auth: {
						apiKey: customProvider?.authMode === "none" ? false : provider.auth.apiKey !== undefined,
						oauth: provider.auth.oauth !== undefined,
					},
					configured: (await this.models.checkAuth(provider.id)) !== undefined,
					credential: metadata.get(provider.id) ?? null,
					modelCount: this.catalog.getModels(provider.id).length,
				};
			}),
		);
		return providers.sort(compareByNameAndId);
	}

	async listModels(providerId: string): Promise<LlmProviderModels> {
		this.requireProvider(providerId);
		const models = this.catalog
			.getModels(providerId)
			.map(
				(model): LlmModelDefinition => ({
					id: model.id,
					providerId: model.provider,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					supportedThinkingLevels: getSupportedThinkingLevels(model),
					input: [...model.input],
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}),
			)
			.sort(compareByNameAndId);
		return { providerId, models };
	}

	listCredentials(): Promise<readonly LlmProviderCredential[]> {
		return this.credentials.listMetadata();
	}

	async getCredential(providerId: string): Promise<LlmProviderCredential> {
		const credential = await this.credentials.getMetadata(providerId);
		if (!credential) throw new ManagementError("not_found", `LLM Provider Credential not found: ${providerId}`);
		return credential;
	}

	async configureApiKey(input: ConfigureLlmProviderApiKeyInput): Promise<LlmProviderCredential> {
		const provider = this.requireProvider(input.providerId);
		const customProvider = this.customProviders.find(input.providerId);
		if (customProvider?.authMode === "none") {
			throw new ManagementError(
				"validation_error",
				`LLM Provider does not require authentication: ${input.providerId}`,
				"type",
			);
		}
		if (!provider.auth.apiKey) {
			throw new ManagementError(
				"validation_error",
				`LLM Provider does not support API key authentication: ${input.providerId}`,
				"type",
			);
		}
		return this.transactions.run(
			async () =>
				this.credentials.putCredential({
					providerId: input.providerId,
					credential: createApiKeyCredential(input),
					...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
					updatedAt: this.clock.now(),
				}).credential,
		);
	}

	async deleteCredential(input: DeleteLlmProviderCredentialInput): Promise<void> {
		await this.transactions.run(async () => this.credentials.deleteCredential(input));
	}

	private requireProvider(providerId: string) {
		const provider = this.models.getProvider(providerId);
		if (!provider) throw new ManagementError("not_found", `LLM Provider not found: ${providerId}`);
		return provider;
	}
}

function compareByNameAndId(left: { name: string; id: string }, right: { name: string; id: string }): number {
	return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
