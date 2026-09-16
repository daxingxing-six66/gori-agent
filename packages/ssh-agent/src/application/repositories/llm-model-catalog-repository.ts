import type { Api, Model } from "@earendil-works/pi-ai";

export interface LlmModelCatalogSnapshot {
	providerId: string;
	models: readonly Model<Api>[];
	checkedAt: number;
	etag?: string;
}

export interface LlmModelCatalogRepository {
	list(): readonly LlmModelCatalogSnapshot[];
	put(snapshot: LlmModelCatalogSnapshot): void;
}
