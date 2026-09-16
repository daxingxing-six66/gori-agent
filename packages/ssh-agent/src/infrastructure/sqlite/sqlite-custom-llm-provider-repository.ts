import type { DatabaseSync } from "node:sqlite";
import type { CustomLlmProviderRepository } from "../../application/repositories/custom-llm-provider-repository.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { CustomLlmProvider } from "../../domain/llm-provider.ts";
import { customLlmProviderFromRow } from "./custom-llm-provider-row.ts";

export class SqliteCustomLlmProviderRepository implements CustomLlmProviderRepository {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	list(): readonly CustomLlmProvider[] {
		return this.#database
			.prepare("SELECT * FROM llm_custom_providers ORDER BY name, id")
			.all()
			.map((row) => customLlmProviderFromRow(row as Record<string, unknown>));
	}

	findById(providerId: string): CustomLlmProvider | undefined {
		const row = this.#database.prepare("SELECT * FROM llm_custom_providers WHERE id = ?").get(providerId);
		return row === undefined ? undefined : customLlmProviderFromRow(row as Record<string, unknown>);
	}

	insert(provider: CustomLlmProvider): void {
		try {
			this.#database
				.prepare(`
					INSERT INTO llm_custom_providers (
						id, name, base_url, api, auth_mode, compat_json, models_json, revision, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(...values(provider));
		} catch (error) {
			if (this.findById(provider.id)) {
				throw new ManagementError(
					"llm_provider_conflict",
					`LLM Provider already exists: ${provider.id}`,
					"id",
					error instanceof Error ? error : undefined,
				);
			}
			throw error;
		}
		this.#database.prepare("DELETE FROM llm_provider_model_catalogs WHERE provider_id = ?").run(provider.id);
	}

	update(provider: CustomLlmProvider, expectedRevision: number): void {
		const result = this.#database
			.prepare(`
					UPDATE llm_custom_providers SET
						name = ?, base_url = ?, api = ?, auth_mode = ?, compat_json = ?, models_json = ?,
						revision = ?, updated_at = ?
					WHERE id = ? AND revision = ?
				`)
			.run(
				provider.name,
				provider.baseUrl,
				provider.api,
				provider.authMode,
				JSON.stringify(provider.compat),
				JSON.stringify(provider.models),
				provider.revision,
				provider.updatedAt,
				provider.id,
				expectedRevision,
			);
		if (result.changes === 0) this.throwWriteConflict(provider.id, expectedRevision);
		this.#database.prepare("DELETE FROM llm_provider_model_catalogs WHERE provider_id = ?").run(provider.id);
	}

	delete(providerId: string, expectedRevision: number): void {
		const result = this.#database
			.prepare("DELETE FROM llm_custom_providers WHERE id = ? AND revision = ?")
			.run(providerId, expectedRevision);
		if (result.changes === 0) this.throwWriteConflict(providerId, expectedRevision);
		this.#database.prepare("DELETE FROM llm_provider_model_catalogs WHERE provider_id = ?").run(providerId);
	}

	private throwWriteConflict(providerId: string, expectedRevision: number): never {
		const current = this.findById(providerId);
		if (!current) throw new ManagementError("not_found", `Custom LLM Provider not found: ${providerId}`);
		throw new ManagementError(
			"revision_conflict",
			`Custom LLM Provider revision is ${current.revision}, not ${expectedRevision}`,
			"expectedRevision",
		);
	}
}

function values(
	provider: CustomLlmProvider,
): [string, string, string, string, string, string, string, number, number, number] {
	return [
		provider.id,
		provider.name,
		provider.baseUrl,
		provider.api,
		provider.authMode,
		JSON.stringify(provider.compat),
		JSON.stringify(provider.models),
		provider.revision,
		provider.createdAt,
		provider.updatedAt,
	];
}
