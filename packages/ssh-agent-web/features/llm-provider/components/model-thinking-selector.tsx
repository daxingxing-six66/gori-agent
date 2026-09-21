"use client";

import { rememberModelSelection } from "@/features/llm-provider/model/last-model-selection";
import { ModelSelector } from "@/features/llm-provider/components/model-selector";
import { ThinkingLevelSelector } from "@/features/llm-provider/components/thinking-level-selector";
import type { LlmModel, ThinkingLevel } from "@/features/llm-provider/model/llm-provider";

export function ModelThinkingSelector({
	selectedModel,
	thinkingLevel,
	disabled = false,
	modelLabel,
	attention = false,
	appearance = "default",
	onSelectModel,
	onSelectThinkingLevel,
}: {
	selectedModel: LlmModel | null;
	thinkingLevel: ThinkingLevel;
	disabled?: boolean;
	modelLabel?: string;
	attention?: boolean;
	appearance?: "default" | "composer";
	onSelectModel(model: LlmModel | null): void;
	onSelectThinkingLevel(level: ThinkingLevel): void;
}) {
	const levels = selectedModel?.supportedThinkingLevels ?? ["off"];
	const composerAppearance = appearance === "composer";
	return (
		<div className={`inline-flex items-center transition ${composerAppearance ? `h-8 rounded-xl border px-0.5 shadow-[0_1px_2px_rgb(24_24_27/3%)] ${attention ? "border-[var(--warning-line)] bg-[var(--warning-soft)]" : "border-transparent bg-[var(--surface-muted)] hover:border-[var(--line-strong)] hover:bg-[var(--surface-hover)]"}` : `h-7 rounded-md ring-1 ${attention ? "bg-amber-50/80 ring-amber-300/80" : "ring-transparent hover:bg-black/[0.018] hover:ring-black/[0.055]"}`}`}>
			<ModelSelector
				selectedModel={selectedModel}
				onSelect={(model) => {
					if (model && (model.id !== selectedModel?.id || model.providerId !== selectedModel?.providerId)) {
						rememberModelSelection({ providerId: model.providerId, modelId: model.id });
					}
					onSelectModel(model);
				}}
				disabled={disabled}
				modelLabel={modelLabel}
				attention={attention}
				appearance={appearance}
				showChevron={levels.length <= 1}
			/>
			{levels.length > 1 && !composerAppearance ? <span aria-hidden="true" className="-mx-0.5 select-none text-[9px] text-zinc-300">·</span> : null}
			<ThinkingLevelSelector
				levels={levels}
				value={thinkingLevel}
				modelName={selectedModel?.name ?? modelLabel}
				disabled={disabled}
				appearance={appearance}
				onChange={onSelectThinkingLevel}
			/>
		</div>
	);
}
