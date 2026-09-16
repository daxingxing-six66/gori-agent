import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { zhCNMessages } from "../features/i18n/messages/zh-CN.ts";
import { ThinkingLevelSlider } from "../features/llm-provider/components/thinking-level-slider.tsx";
import { ThinkingLevelSelector } from "../features/llm-provider/components/thinking-level-selector.tsx";
import {
	deriveLlmProviderState,
	thinkingLevelForModel,
	type LlmModel,
	type LlmProvider,
} from "../features/llm-provider/model/llm-provider.ts";

const providers: LlmProvider[] = [
	{
		id: "stored",
		name: "Stored",
		custom: false,
		baseUrl: "https://stored.example",
		auth: { apiKey: true, oauth: false },
		configured: true,
		credential: { providerId: "stored", type: "api_key", revision: 1, createdAt: 1, updatedAt: 1 },
		modelCount: 1,
	},
	{
		id: "ambient",
		name: "Ambient",
		custom: false,
		baseUrl: null,
		auth: { apiKey: true, oauth: false },
		configured: true,
		credential: null,
		modelCount: 2,
	},
	{
		id: "missing",
		name: "Missing",
		custom: false,
		baseUrl: "https://missing.example",
		auth: { apiKey: true, oauth: false },
		configured: false,
		credential: null,
		modelCount: 3,
	},
];

function renderWithLocale(element: ReactElement): string {
	return renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, element));
}

describe("LLM Provider state", () => {
	it("separates stored Credentials, configurable Providers, and authenticated model Providers", () => {
		const state = deriveLlmProviderState(providers);
		expect(state.credentialProviders.map((provider) => provider.id)).toEqual(["stored"]);
		expect(state.configurableProviders.map((provider) => provider.id)).toEqual(["ambient", "missing"]);
		expect(state.modelProviders.map((provider) => provider.id)).toEqual(["stored", "ambient"]);
	});

	it("keeps supported thinking levels and falls back safely when models change", () => {
		const model: LlmModel = {
			id: "reasoning-model",
			providerId: "stored",
			name: "Reasoning Model",
			api: "test",
			reasoning: true,
			supportedThinkingLevels: ["off", "low", "high"],
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 8_192,
		};
		expect(thinkingLevelForModel(model, "high")).toBe("high");
		expect(thinkingLevelForModel(model, "max")).toBe("off");
		expect(thinkingLevelForModel({ ...model, supportedThinkingLevels: ["medium", "high"] }, "off")).toBe("medium");
	});

	it("only renders the thinking selector when the model exposes multiple levels", () => {
		expect(renderWithLocale(createElement(ThinkingLevelSelector, {
			levels: ["off"],
			value: "off",
			onChange: () => undefined,
		}))).toBe("");
		expect(renderWithLocale(createElement(ThinkingLevelSelector, {
			levels: ["off", "medium"],
			value: "medium",
			onChange: () => undefined,
		}))).toContain(">中<");
	});

	it("renders the shared thinking slider for supported levels", () => {
		const markup = renderWithLocale(createElement(ThinkingLevelSlider, {
			levels: ["off", "low", "high"],
			value: "low",
			modelName: "Reasoning Model",
			onChange: () => undefined,
		}));
		expect(markup).toContain("Reasoning Model");
		expect(markup).toContain("width:50%");
		expect(markup).toContain("aria-label=\"选择思考等级\"");
	});
});
