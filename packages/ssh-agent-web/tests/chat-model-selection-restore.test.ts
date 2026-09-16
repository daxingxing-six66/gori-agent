import { describe, expect, it } from "vitest";
import {
	chatModelRestoreReducer,
	initialChatModelRestoreState,
	resolveChatModelSelection,
} from "../features/chat/model/chat-model-selection-restore.ts";
import type { LlmModel } from "../features/llm-provider/model/llm-provider.ts";

const model: LlmModel = {
	id: "deepseek-v4-flash",
	providerId: "deepseek",
	name: "DeepSeek V4 Flash",
	api: "openai-completions",
	reasoning: true,
	supportedThinkingLevels: ["off", "low", "high"],
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 8_192,
};

describe("Chat model selection restore", () => {
	it("restores a historical model that remains available", async () => {
		const result = await resolveChatModelSelection(
			{ providerId: model.providerId, modelId: model.id, thinkingLevel: "high" },
			new AbortController().signal,
			async () => model,
		);

		expect(result).toEqual({
			status: "resolved",
			model,
			thinkingLevel: "high",
			thinkingLevelChanged: false,
		});
	});

	it("finishes restoration when the historical model is unavailable", async () => {
		const result = await resolveChatModelSelection(
			{ providerId: model.providerId, modelId: model.id, thinkingLevel: "high" },
			new AbortController().signal,
			async () => null,
		);
		let state = chatModelRestoreReducer(initialChatModelRestoreState("session-1"), {
			type: "reset",
			sessionId: "session-1",
			requestToken: 1,
		});
		state = chatModelRestoreReducer(state, { type: "unavailable", sessionId: "session-1", requestToken: 1 });
		state = chatModelRestoreReducer(state, { type: "settled", sessionId: "session-1", requestToken: 1 });

		expect(result).toEqual({ status: "unavailable" });
		expect(state).toMatchObject({
			model: null,
			loading: false,
			error: { type: "model_unavailable" },
			errorRetryable: false,
		});
	});

	it("allows a second restore after the first request is aborted", async () => {
		const firstController = new AbortController();
		const first = resolveChatModelSelection(
			{ providerId: model.providerId, modelId: model.id, thinkingLevel: "low" },
			firstController.signal,
			(_selection, signal) => new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			}),
		);
		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });

		const second = await resolveChatModelSelection(
			{ providerId: model.providerId, modelId: model.id, thinkingLevel: "low" },
			new AbortController().signal,
			async () => model,
		);
		expect(second).toMatchObject({ status: "resolved", model, thinkingLevel: "low" });
	});

	it("keeps the Strict Mode setup-cleanup-setup replacement request authoritative", () => {
		let state = initialChatModelRestoreState("session-1");
		state = chatModelRestoreReducer(state, { type: "reset", sessionId: "session-1", requestToken: 1 });
		state = chatModelRestoreReducer(state, { type: "start", sessionId: "session-1", requestToken: 1 });
		state = chatModelRestoreReducer(state, { type: "reset", sessionId: "session-1", requestToken: 2 });
		state = chatModelRestoreReducer(state, { type: "start", sessionId: "session-1", requestToken: 2 });
		state = chatModelRestoreReducer(state, {
			type: "resolved",
			sessionId: "session-1",
			requestToken: 2,
			model,
			thinkingLevel: "high",
			thinkingLevelChanged: false,
		});
		state = chatModelRestoreReducer(state, { type: "settled", sessionId: "session-1", requestToken: 2 });

		expect(state).toMatchObject({ model, thinkingLevel: "high", loading: false });
	});

	it("ignores a stale response after switching sessions", () => {
		let state = initialChatModelRestoreState("session-1");
		state = chatModelRestoreReducer(state, { type: "reset", sessionId: "session-1", requestToken: 1 });
		state = chatModelRestoreReducer(state, { type: "reset", sessionId: "session-2", requestToken: 2 });
		const staleState = chatModelRestoreReducer(state, {
			type: "resolved",
			sessionId: "session-1",
			requestToken: 1,
			model,
			thinkingLevel: "high",
			thinkingLevelChanged: false,
		});

		expect(staleState).toEqual(state);
		expect(staleState).toMatchObject({ sessionId: "session-2", model: null, loading: true });
	});
});
