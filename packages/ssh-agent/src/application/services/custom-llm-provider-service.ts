import type { MutableModels } from "@earendil-works/pi-ai";
import { ManagementError } from "../../domain/errors.ts";
import type { Clock } from "../../domain/ids.ts";
import type {
	CreateCustomLlmProviderInput,
	CustomLlmModel,
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
import { discoverCustomLlmModels } from "./custom-llm-model-discovery.ts";
import { modelRefreshFailed } from "./llm-model-refresh-error.ts";
import { HttpBoundaryError } from "../failure-policy.ts";
import { backendMessage } from "../../i18n/message.ts";

export interface CustomLlmProviderService {
	list(): Promise<readonly CustomLlmProvider[]>;
	get(providerId: string): Promise<CustomLlmProvider>;
	create(input: CreateCustomLlmProviderInput): Promise<CustomLlmProvider>;
	update(input: UpdateCustomLlmProviderInput): Promise<CustomLlmProvider>;
	delete(input: DeleteCustomLlmProviderInput): Promise<void>;
	find(providerId: string): CustomLlmProvider | undefined;
	refreshModels(providerId: string, signal: AbortSignal): Promise<void>;
}

export interface DefaultCustomLlmProviderServiceOptions {
	repository: CustomLlmProviderRepository;
	runtime: CustomLlmProviderRuntime;
	models: MutableModels;
	clock: Clock;
	credentials: LlmProviderCredentialStore;
	transactions: TransactionRunner;
	hasActiveRun(providerId: string): boolean;
	fetch?: typeof fetch;
}

export class DefaultCustomLlmProviderService implements CustomLlmProviderService {
	readonly #repository: CustomLlmProviderRepository;
	readonly #runtime: CustomLlmProviderRuntime;
	readonly #models: MutableModels;
	readonly #clock: Clock;
	readonly #credentials: LlmProviderCredentialStore;
	readonly #transactions: TransactionRunner;
	readonly #hasActiveRun: (providerId: string) => boolean;
	readonly #fetch: typeof fetch;
	readonly #generations = new Map<string, number>();

	constructor(options: DefaultCustomLlmProviderServiceOptions) {
		this.#repository = options.repository;
		this.#runtime = options.runtime;
		this.#models = options.models;
		this.#clock = options.clock;
		this.#credentials = options.credentials;
		this.#transactions = options.transactions;
		this.#hasActiveRun = options.hasActiveRun;
		this.#fetch = options.fetch ?? globalThis.fetch;
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
		this.bumpGeneration(provider.id);
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
		this.bumpGeneration(provider.id);
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
		this.bumpGeneration(input.providerId);
	}

	find(providerId: string): CustomLlmProvider | undefined {
		return this.#repository.findById(providerId);
	}

	async refreshModels(providerId: string, signal: AbortSignal): Promise<void> {
		const current = this.requireProvider(providerId);
		const generation = this.#generations.get(providerId);
		this.requireIdle(providerId);
		const authentication = await this.#transactions.run(async () => {
			if (this.#generations.get(providerId) !== generation || JSON.stringify(this.requireProvider(providerId)) !== JSON.stringify(current)) {
				throw new ManagementError("revision_conflict", "Provider changed before model discovery", "expectedRevision");
			}
			return {
				metadata: await this.#credentials.getMetadata(providerId),
				credential: current.authMode === "api_key" ? await this.#credentials.read(providerId, { signal }) : undefined,
			};
		});
		const apiKey = authentication.credential?.type === "api_key" ? authentication.credential.key : undefined;
		if (current.authMode === "api_key" && !apiKey) {
			throw new HttpBoundaryError("llm_provider_not_configured", 409, backendMessage("chat.provider_not_configured"));
		}
		let models: CustomLlmModel[];
		try { models = await discoverCustomLlmModels(current, apiKey, signal, this.#fetch); }
		catch { throw modelRefreshFailed(); }
		const updated = buildCustomLlmProvider({ ...current, models }, current.revision + 1, current.createdAt, this.#clock.now());
		await this.#transactions.run(async () => {
			signal.throwIfAborted();
			this.requireIdle(providerId);
			if (this.#generations.get(providerId) !== generation || JSON.stringify(this.requireProvider(providerId)) !== JSON.stringify(current)) {
				throw new ManagementError("revision_conflict", "Provider changed during model discovery", "expectedRevision");
			}
			const metadata = await this.#credentials.getMetadata(providerId);
			const credential = current.authMode === "api_key" ? await this.#credentials.read(providerId, { signal }) : undefined;
			if (JSON.stringify(metadata) !== JSON.stringify(authentication.metadata) || JSON.stringify(credential) !== JSON.stringify(authentication.credential)) {
				throw new ManagementError("revision_conflict", "Provider authentication changed during model discovery", "expectedRevision");
			}
			this.#repository.update(updated, current.revision);
		});
		this.#runtime.register(updated);
		this.bumpGeneration(providerId);
	}

	private bumpGeneration(providerId: string): void {
		this.#generations.set(providerId, (this.#generations.get(providerId) ?? 0) + 1);
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
