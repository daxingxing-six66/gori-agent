import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CustomProviderModelDiscoveryError,
	defaultModelsEndpoint,
	discoverCustomProviderModels,
} from "../features/llm-provider/model/custom-provider-model-discovery.ts";

afterEach(() => vi.unstubAllGlobals());

describe("custom Provider model discovery", () => {
	it("builds the default model endpoint from the Provider origin", () => {
		expect(defaultModelsEndpoint("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/models");
		expect(defaultModelsEndpoint("http://127.0.0.1:11434/v1/chat?key=value")).toBe("http://127.0.0.1:11434/models");
		expect(defaultModelsEndpoint("not-a-url")).toBe("");
	});

	it("loads and normalizes OpenAI-compatible model responses", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(Response.json({
			data: [{ id: "model-b" }, { id: "model-a", name: "Model A" }, { id: "model-b" }],
		})));
		vi.stubGlobal("fetch", fetchMock);

		await expect(discoverCustomProviderModels({
			endpoint: "https://api.example.com/models",
			api: "openai-completions",
			apiKey: " secret ",
		})).resolves.toEqual([
			{ id: "model-b", name: "model-b" },
			{ id: "model-a", name: "Model A" },
		]);
		expect(fetchMock).toHaveBeenCalledWith(new URL("https://api.example.com/models"), expect.objectContaining({
			headers: { accept: "application/json", authorization: "Bearer secret" },
		}));
	});

	it("does not request the model endpoint without an API Key", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(discoverCustomProviderModels({
			endpoint: "https://api.example.com/models",
			api: "openai-completions",
			apiKey: "   ",
		})).rejects.toEqual(new CustomProviderModelDiscoveryError("api_key_required"));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("supports models arrays and protocol-specific API Key headers", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(Response.json({
			models: [{ name: "models/gemini-test", displayName: "Gemini Test" }],
		})));
		vi.stubGlobal("fetch", fetchMock);

		await expect(discoverCustomProviderModels({
			endpoint: "https://generativelanguage.googleapis.com/models",
			api: "google-generative-ai",
			apiKey: "google-secret",
		})).resolves.toEqual([{ id: "gemini-test", name: "Gemini Test" }]);
		expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
			headers: { accept: "application/json", "x-goog-api-key": "google-secret" },
		}));
	});
});
