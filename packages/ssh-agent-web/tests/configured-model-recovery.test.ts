import { afterEach, describe, expect, it, vi } from "vitest";
import { llmProviderApi, resolveConfiguredModel } from "../features/llm-provider/api/llm-provider-api";
import { type LlmModel, type LlmProvider, thinkingLevelForModel } from "../features/llm-provider/model/llm-provider";

const model: LlmModel = {
	id: "selected-model", providerId: "provider", name: "Selected model", api: "openai-completions",
	reasoning: true, supportedThinkingLevels: ["off", "low"], input: ["text"], contextWindow: 128000, maxTokens: 8192,
};
const provider: LlmProvider = {
	id: "provider", name: "Provider", custom: false, baseUrl: null,
	auth: { apiKey: true, oauth: false }, configured: true, credential: null, modelCount: 2,
};

afterEach(() => vi.restoreAllMocks());

describe("configured model recovery", () => {
	it("resolves the selected id rather than another catalog model and recovers thinking level", async () => {
		vi.spyOn(llmProviderApi, "listProviders").mockResolvedValue({ providers: [provider] });
		const listModels = vi.spyOn(llmProviderApi, "listModels").mockResolvedValue({
			providerId: provider.id, models: [{ ...model, id: "other-model" }, model],
		});
		const refreshed = await resolveConfiguredModel({ providerId: model.providerId, modelId: model.id });
		expect(listModels).toHaveBeenCalledWith(model.providerId, undefined);
		expect(refreshed).toEqual(model);
		if (!refreshed) throw new Error("Expected configured model");
		expect(thinkingLevelForModel(refreshed, "high")).toBe("off");
	});
	it("does not substitute another model when the selected model was removed", async () => {
		vi.spyOn(llmProviderApi, "listProviders").mockResolvedValue({ providers: [provider] });
		vi.spyOn(llmProviderApi, "listModels").mockResolvedValue({ providerId: provider.id, models: [{ ...model, id: "other-model" }] });
		expect(await resolveConfiguredModel({ providerId: model.providerId, modelId: model.id })).toBeNull();
	});
	it("does not fetch models for an unconfigured provider", async () => {
		vi.spyOn(llmProviderApi, "listProviders").mockResolvedValue({ providers: [{ ...provider, configured: false }] });
		const listModels = vi.spyOn(llmProviderApi, "listModels");
		expect(await resolveConfiguredModel({ providerId: model.providerId, modelId: model.id })).toBeNull();
		expect(listModels).not.toHaveBeenCalled();
	});
});
