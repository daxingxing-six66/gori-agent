import type { ChatCompactionSettings, UpdateChatCompactionSettingsInput } from "../../domain/context-compaction.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { Clock } from "../../domain/ids.ts";
import type { ContextCompactionSettingsRepository } from "../repositories/context-compaction-settings-repository.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";

export class ContextCompactionSettingsService {
	readonly #repository: ContextCompactionSettingsRepository;
	readonly #catalog: Pick<LlmModelCatalog, "getModel">;
	readonly #clock: Clock;

	constructor(options: {
		repository: ContextCompactionSettingsRepository;
		catalog: Pick<LlmModelCatalog, "getModel">;
		clock: Clock;
	}) {
		this.#repository = options.repository;
		this.#catalog = options.catalog;
		this.#clock = options.clock;
	}

	get(): ChatCompactionSettings {
		return this.#repository.get();
	}

	update(input: UpdateChatCompactionSettingsInput): ChatCompactionSettings {
		if (!Number.isSafeInteger(input.triggerPercent) || input.triggerPercent < 1 || input.triggerPercent > 99) {
			throw new ManagementError(
				"validation_error",
				"triggerPercent must be an integer between 1 and 99",
				"triggerPercent",
			);
		}
		if (input.model !== null && !this.#catalog.getModel(input.model.providerId, input.model.modelId)) {
			throw new ManagementError("not_found", "Compaction model not found", "model");
		}
		const updated = this.#repository.update({
			triggerPercent: input.triggerPercent,
			providerId: input.model?.providerId ?? null,
			modelId: input.model?.modelId ?? null,
			expectedRevision: input.expectedRevision,
			updatedAt: this.#clock.now(),
		});
		if (!updated) throw new ManagementError("revision_conflict", "Compaction settings revision conflict");
		return updated;
	}
}
