import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Clock } from "../../domain/ids.ts";
import type {
	LlmModelCatalogRepository,
	LlmModelCatalogSnapshot,
} from "../repositories/llm-model-catalog-repository.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";

export interface LlmModelCatalog {
	getModels(providerId: string): readonly Model<Api>[];
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
	refresh(providerId: string, signal?: AbortSignal): Promise<void>;
	removeModel(providerId: string, modelId: string): boolean;
}

export interface DefaultLlmModelCatalogOptions {
	models: Models;
	repository: LlmModelCatalogRepository;
	clock: Clock;
	baseUrl?: string;
	fetch?: typeof fetch;
}

export class DefaultLlmModelCatalog implements LlmModelCatalog {
	private readonly models: Models;
	private readonly repository: LlmModelCatalogRepository;
	private readonly clock: Clock;
	private readonly baseUrl: string;
	private readonly fetch: typeof fetch;
	private readonly snapshots = new Map<string, LlmModelCatalogSnapshot>();

	constructor(options: DefaultLlmModelCatalogOptions) {
		this.models = options.models;
		this.repository = options.repository;
		this.clock = options.clock;
		this.baseUrl = options.baseUrl ?? DEFAULT_CATALOG_BASE_URL;
		this.fetch = options.fetch ?? globalThis.fetch;
		for (const snapshot of this.repository.list()) this.snapshots.set(snapshot.providerId, snapshot);
	}

	getModels(providerId: string): readonly Model<Api>[] {
		return this.snapshots.get(providerId)?.models ?? this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.getModels(providerId).find((model) => model.id === modelId);
	}

	async refresh(providerId: string, signal?: AbortSignal): Promise<void> {
		if (!this.models.getProvider(providerId)) throw new Error(`Unknown LLM provider: ${providerId}`);
		const stored = this.snapshots.get(providerId);
		const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, this.baseUrl);
		const response = await this.fetch(url, {
			headers: {
				accept: "application/json",
				...(stored?.etag === undefined ? {} : { "if-none-match": stored.etag }),
			},
			...(signal === undefined ? {} : { signal }),
		});
		if (response.status === 304) {
			if (!stored) throw new Error(`Model catalog returned 304 without a stored snapshot: ${providerId}`);
			this.publish({ ...stored, checkedAt: this.clock.now() });
			return;
		}
		if (!response.ok) throw new Error(`Model catalog request failed for ${providerId}: ${response.status}`);
		const etag = response.headers.get("etag");
		const snapshot: LlmModelCatalogSnapshot = {
			providerId,
			models: parseCatalog(providerId, await response.json()),
			checkedAt: this.clock.now(),
			...(etag === null ? {} : { etag }),
		};
		this.publish(snapshot);
	}

	removeModel(providerId: string, modelId: string): boolean {
		const models = this.getModels(providerId);
		const next = models.filter((model) => model.id !== modelId);
		if (next.length === models.length) return false;
		const etag = this.snapshots.get(providerId)?.etag;
		this.publish({
			providerId,
			models: next,
			checkedAt: this.clock.now(),
			...(etag === undefined ? {} : { etag }),
		});
		return true;
	}

	private publish(snapshot: LlmModelCatalogSnapshot): void {
		this.repository.put(snapshot);
		this.snapshots.set(snapshot.providerId, snapshot);
	}
}

function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.models)
			? value.models
			: isRecord(value)
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries.map((entry) => parseModel(providerId, entry));
}

function parseModel(providerId: string, value: unknown): Model<Api> {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.name) ||
		!isNonEmptyString(value.api) ||
		!isNonEmptyString(value.baseUrl) ||
		typeof value.reasoning !== "boolean" ||
		!Array.isArray(value.input) ||
		!value.input.every((input) => input === "text" || input === "image") ||
		!isModelCost(value.cost) ||
		!isFiniteNumber(value.contextWindow) ||
		!isFiniteNumber(value.maxTokens)
	) {
		throw new Error(`Invalid model catalog entry for provider "${providerId}"`);
	}
	return { ...value, provider: providerId } as unknown as Model<Api>;
}

function isModelCost(value: unknown): boolean {
	return (
		isRecord(value) &&
		isFiniteNumber(value.input) &&
		isFiniteNumber(value.output) &&
		isFiniteNumber(value.cacheRead) &&
		isFiniteNumber(value.cacheWrite) &&
		(value.tiers === undefined ||
			(Array.isArray(value.tiers) &&
				value.tiers.every(
					(tier) =>
						isRecord(tier) &&
						isFiniteNumber(tier.inputTokensAbove) &&
						isFiniteNumber(tier.input) &&
						isFiniteNumber(tier.output) &&
						isFiniteNumber(tier.cacheRead) &&
						isFiniteNumber(tier.cacheWrite),
				)))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
