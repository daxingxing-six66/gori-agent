import type { CompactionPreparation, compact } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { requestCompactionSummary } from "../src/application/compaction-summary-request.ts";

const preparation: CompactionPreparation = {
	messagesToSummarize: [],
	turnPrefixMessages: [],
	retainedTail: [],
	isSplitTurn: false,
	tokensBefore: 100,
	fileOps: { read: new Set(), written: new Set(), edited: new Set() },
	settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
};

describe("compaction summary request ownership", () => {
	it("preserves method receivers and clears a recovered request error", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "summary", models: [{ id: "model" }] });
		models.setProvider(faux.provider);
		const complete = vi
			.spyOn(models, "completeSimple")
			.mockResolvedValueOnce(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: '429: {"message":"Temporary limit"}' }),
			)
			.mockResolvedValueOnce(fauxAssistantMessage("recovered"));
		const getProviders = vi.spyOn(models, "getProviders").mockImplementation(function (this: typeof models) {
			expect(this).toBe(models);
			return [faux.provider];
		});
		const cause = new TypeError("unrelated compactor bug");
		const compactor: typeof compact = async (_preparation, adapted, model) => {
			expect(adapted.getProviders()).toEqual([faux.provider]);
			await adapted.completeSimple(model, { messages: [] });
			await adapted.completeSimple(model, { messages: [] });
			throw cause;
		};
		await expect(requestCompactionSummary(compactor, preparation, models, faux.getModel())).rejects.toMatchObject({
			cause,
			publicMessage: undefined,
			retryable: false,
		});
		expect(complete).toHaveBeenCalledTimes(2);
		expect(getProviders).toHaveBeenCalledOnce();
		expect(models.completeSimple).toBe(complete);
	});

	it("does not retain a previous attempt's provider reason", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "summary", models: [{ id: "model" }] });
		models.setProvider(faux.provider);
		vi.spyOn(models, "completeSimple")
			.mockRejectedValueOnce(Object.assign(new Error("Insufficient balance"), { status: 402 }))
			.mockRejectedValueOnce(new TypeError("internal"));
		const compactor: typeof compact = async (_preparation, adapted, model) => {
			await adapted.completeSimple(model, { messages: [] });
			throw new Error("unreachable");
		};
		await expect(requestCompactionSummary(compactor, preparation, models, faux.getModel())).rejects.toMatchObject({
			publicMessage: { key: "provider.compaction_failed" },
			retryable: false,
		});
		await expect(requestCompactionSummary(compactor, preparation, models, faux.getModel())).rejects.toMatchObject({
			publicMessage: undefined,
			retryable: false,
		});
	});
});
