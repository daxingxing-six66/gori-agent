import type { LlmModel } from "@/features/llm-provider/model/llm-provider";

export interface ContextCompactionModelSelection {
	providerId: string;
	modelId: string;
}

export interface ContextCompactionSettings {
	triggerPercent: number;
	model: ContextCompactionModelSelection | null;
	revision: number;
	updatedAt: number;
}

export interface ContextCompactionSettingsDraft {
	triggerPercent: number;
	model: ContextCompactionModelSelection | null;
}

export function contextCompactionSettingsDraft(
	settings: ContextCompactionSettings,
): ContextCompactionSettingsDraft {
	return {
		triggerPercent: settings.triggerPercent,
		model: settings.model,
	};
}

export function contextCompactionModelSelection(model: LlmModel): ContextCompactionModelSelection {
	return { providerId: model.providerId, modelId: model.id };
}

export function sameContextCompactionDraft(
	settings: ContextCompactionSettings,
	draft: ContextCompactionSettingsDraft,
): boolean {
	return settings.triggerPercent === draft.triggerPercent && sameModelSelection(settings.model, draft.model);
}

function sameModelSelection(
	left: ContextCompactionModelSelection | null,
	right: ContextCompactionModelSelection | null,
): boolean {
	if (left === null || right === null) return left === right;
	return left.providerId === right.providerId && left.modelId === right.modelId;
}
