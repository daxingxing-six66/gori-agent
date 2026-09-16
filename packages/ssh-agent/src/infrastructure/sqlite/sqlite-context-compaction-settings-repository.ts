import type { DatabaseSync } from "node:sqlite";
import type { ContextCompactionSettingsRepository } from "../../application/repositories/context-compaction-settings-repository.ts";
import type { ChatCompactionSettings } from "../../domain/context-compaction.ts";

export class SqliteContextCompactionSettingsRepository implements ContextCompactionSettingsRepository {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	get(): ChatCompactionSettings {
		return settingsFromRow(this.#database.prepare("SELECT * FROM chat_compaction_settings WHERE id = 1").get());
	}

	update(input: {
		triggerPercent: number;
		providerId: string | null;
		modelId: string | null;
		expectedRevision: number;
		updatedAt: number;
	}): ChatCompactionSettings | undefined {
		const result = this.#database
			.prepare(
				"UPDATE chat_compaction_settings SET trigger_percent = ?, provider_id = ?, model_id = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING *",
			)
			.get(input.triggerPercent, input.providerId, input.modelId, input.updatedAt, input.expectedRevision);
		return result === undefined ? undefined : settingsFromRow(result);
	}
}

function settingsFromRow(row: unknown): ChatCompactionSettings {
	if (!row) throw new Error("Compaction settings row is missing");
	const value = row as Record<string, unknown>;
	const providerId = value.provider_id === null ? null : String(value.provider_id);
	const modelId = value.model_id === null ? null : String(value.model_id);
	return {
		triggerPercent: Number(value.trigger_percent),
		model: providerId === null || modelId === null ? null : { providerId, modelId },
		revision: Number(value.revision),
		updatedAt: Number(value.updated_at),
	};
}
