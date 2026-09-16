import type { MutableModels } from "@earendil-works/pi-ai";
import { ManagementError } from "../../domain/errors.ts";
import type { Clock } from "../../domain/ids.ts";
import type {
	CreateCustomLlmProviderInput,
	CustomLlmProvider,
	DeleteCustomLlmProviderInput,
	UpdateCustomLlmProviderInput,
} from "../../domain/llm-provider.ts";
import { buildCustomLlmProvider } from "../custom-llm-provider-factory.ts";
import type { CustomLlmProviderRepository } from "../repositories/custom-llm-provider-repository.ts";
import type { LlmProviderCredentialStore } from "../repositories/llm-provider-credential-store.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import type { CustomLlmProviderRuntime } from "./custom-llm-provider-runtime.ts";
import { createApiKeyCredential } from "./llm-provider-api-key.ts";

export interface CustomLlmProviderService {
	list(): Promise<readonly CustomLlmProvider[]>;
	get(providerId: string): Promise<CustomLlmProvider>;
	create(input: CreateCustomLlmProviderInput): Promise<CustomLlmProvider>;
	update(input: UpdateCustomLlmProviderInput): Promise<CustomLlmProvider>;
	delete(input: DeleteCustomLlmProviderInput): Promise<void>;
	find(providerId: string): CustomLlmProvider | undefined;
}

export interface DefaultCustomLlmProviderServiceOptions {
	repository: CustomLlmProviderRepository;
	runtime: CustomLlmProviderRuntime;
	models: MutableModels;
	clock: Clock;
	credentials: LlmProviderCredentialStore;
	transactions: TransactionRunner;
	hasActiveRun(providerId: string): boolean;
}

export class DefaultCustomLlmProviderService implements CustomLlmProviderService {
	readonly #repository: CustomLlmProviderRepository;
	readonly #runtime: CustomLlmProviderRuntime;
	readonly #models: MutableModels;
	readonly #clock: Clock;
	readonly #credentials: LlmProviderCredentialStore;
	readonly #transactions: TransactionRunner;
	readonly #hasActiveRun: (providerId: string) => boolean;

	constructor(options: DefaultCustomLlmProviderServiceOptions) {
		this.#repository = options.repository;
		this.#runtime = options.runtime;
		this.#models = options.models;
		this.#clock = options.clock;
		this.#credentials = options.credentials;
		this.#transactions = options.transactions;
		this.#hasActiveRun = options.hasActiveRun;
	}

	restore(): void {
		for (const provider of this.#repository.list()) {
			if (this.#models.getProvider(provider.id)) {
				throw new ManagementError(
					"llm_provider_conflict",
					`LLM Provider ID conflicts with a built-in Provider: ${provider.id}`,
				);
			}
			this.#runtime.register(provider);
		}
	}

	list(): Promise<readonly CustomLlmProvider[]> {
		return Promise.resolve(this.#repository.list());
	}

	async get(providerId: string): Promise<CustomLlmProvider> {
		return this.requireProvider(providerId);
	}

	async create(input: CreateCustomLlmProviderInput): Promise<CustomLlmProvider> {
		if (this.#models.getProvider(input.id) || this.#repository.findById(input.id)) {
			throw new ManagementError("llm_provider_conflict", `LLM Provider already exists: ${input.id}`, "id");
		}
		const now = this.#clock.now();
		const provider = buildCustomLlmProvider(input, 1, now, now);
		if (provider.authMode === "none" && input.credential !== undefined) {
			throw new ManagementError("validation_error", "credential is not valid when authMode is none", "credential");
		}
		const credential = input.credential ? createApiKeyCredential(input.credential, "credential.") : undefined;
		await this.#transactions.run(async () => {
			this.#repository.insert(provider);
			if (credential) {
				this.#credentials.putCredential({
					providerId: provider.id,
					credential,
					updatedAt: now,
				});
			}
		});
		this.#runtime.register(provider);
		return provider;
	}

	async update(input: UpdateCustomLlmProviderInput): Promise<CustomLlmProvider> {
		const current = this.requireProvider(input.providerId);
		this.requireIdle(input.providerId);
		const provider = buildCustomLlmProvider(
			{ ...input, id: input.providerId },
			current.revision + 1,
			current.createdAt,
			this.#clock.now(),
		);
		await this.#transactions.run(async () => {
			this.#repository.update(provider, input.expectedRevision);
			if (current.authMode === "api_key" && provider.authMode === "none") {
				this.#credentials.removeCredential(provider.id);
			}
		});
		this.#runtime.register(provider);
		return provider;
	}

	async delete(input: DeleteCustomLlmProviderInput): Promise<void> {
		this.requireProvider(input.providerId);
		this.requireIdle(input.providerId);
		await this.#transactions.run(async () => {
			this.#repository.delete(input.providerId, input.expectedRevision);
			this.#credentials.removeCredential(input.providerId);
		});
		this.#runtime.remove(input.providerId);
	}

	find(providerId: string): CustomLlmProvider | undefined {
		return this.#repository.findById(providerId);
	}

	private requireProvider(providerId: string): CustomLlmProvider {
		const provider = this.#repository.findById(providerId);
		if (!provider) throw new ManagementError("not_found", `Custom LLM Provider not found: ${providerId}`);
		return provider;
	}

	private requireIdle(providerId: string): void {
		if (this.#hasActiveRun(providerId)) {
			throw new ManagementError("llm_provider_in_use", `LLM Provider has an active Chat Run: ${providerId}`);
		}
	}
}
