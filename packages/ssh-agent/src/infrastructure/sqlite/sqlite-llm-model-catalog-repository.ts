import type { DatabaseSync } from "node:sqlite";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	LlmModelCatalogRepository,
	LlmModelCatalogSnapshot,
} from "../../application/repositories/llm-model-catalog-repository.ts";

type CatalogRow = {
	provider_id: string;
	models_json: string;
	checked_at: number;
	etag: string | null;
};

export class SqliteLlmModelCatalogRepository implements LlmModelCatalogRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	list(): readonly LlmModelCatalogSnapshot[] {
		return this.database
			.prepare("SELECT provider_id, models_json, checked_at, etag FROM llm_provider_model_catalogs")
			.all()
			.map((row) => toSnapshot(row as CatalogRow));
	}

	put(snapshot: LlmModelCatalogSnapshot): void {
		this.database
			.prepare(`
				INSERT INTO llm_provider_model_catalogs (provider_id, models_json, checked_at, etag)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(provider_id) DO UPDATE SET
					models_json = excluded.models_json,
					checked_at = excluded.checked_at,
					etag = excluded.etag
			`)
			.run(snapshot.providerId, JSON.stringify(snapshot.models), snapshot.checkedAt, snapshot.etag ?? null);
	}
}

function toSnapshot(row: CatalogRow): LlmModelCatalogSnapshot {
	const value: unknown = JSON.parse(row.models_json);
	if (!Array.isArray(value)) throw new Error(`Invalid stored LLM model catalog: ${row.provider_id}`);
	return {
		providerId: row.provider_id,
		models: value as Model<Api>[],
		checkedAt: row.checked_at,
		...(row.etag === null ? {} : { etag: row.etag }),
	};
}
