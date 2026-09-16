import type { ChatCompactionSettings } from "../../domain/context-compaction.ts";

export interface ContextCompactionSettingsRepository {
	get(): ChatCompactionSettings;
	update(input: {
		triggerPercent: number;
		providerId: string | null;
		modelId: string | null;
		expectedRevision: number;
		updatedAt: number;
	}): ChatCompactionSettings | undefined;
}
