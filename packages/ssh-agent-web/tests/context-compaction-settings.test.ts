import { describe, expect, it } from "vitest";
import {
	contextCompactionModelSelection,
	contextCompactionSettingsDraft,
	sameContextCompactionDraft,
} from "../features/context-compaction/model/context-compaction-settings.ts";
import type { LlmModel } from "../features/llm-provider/model/llm-provider.ts";

const settings = {
	triggerPercent: 80,
	model: { providerId: "anthropic", modelId: "claude-sonnet" },
	revision: 3,
	updatedAt: 1_787_000_000_000,
};

describe("context compaction settings state", () => {
	it("creates an editable draft without revision metadata", () => {
		expect(contextCompactionSettingsDraft(settings)).toEqual({
			triggerPercent: 80,
			model: { providerId: "anthropic", modelId: "claude-sonnet" },
		});
	});

	it("detects threshold and model changes", () => {
		expect(sameContextCompactionDraft(settings, contextCompactionSettingsDraft(settings))).toBe(true);
		expect(sameContextCompactionDraft(settings, { triggerPercent: 75, model: settings.model })).toBe(false);
		expect(sameContextCompactionDraft(settings, { triggerPercent: 80, model: null })).toBe(false);
		expect(sameContextCompactionDraft(settings, {
			triggerPercent: 80,
			model: { providerId: "anthropic", modelId: "claude-opus" },
		})).toBe(false);
	});

	it("derives the persisted selection from a catalog model", () => {
		const model: LlmModel = {
			id: "deepseek-chat",
			providerId: "deepseek",
			name: "DeepSeek Chat",
			api: "openai-completions",
			reasoning: false,
			supportedThinkingLevels: ["off"],
			input: ["text"],
			contextWindow: 64_000,
			maxTokens: 8_192,
		};
		expect(contextCompactionModelSelection(model)).toEqual({
			providerId: "deepseek",
			modelId: "deepseek-chat",
		});
	});
});
