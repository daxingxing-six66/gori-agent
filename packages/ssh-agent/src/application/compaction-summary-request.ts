import type { CompactResult, compact } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { ChatCompactionError } from "../domain/context-compaction.ts";
import {
	annotateProviderFailure,
	normalizeProviderFailure,
	type ProviderFailure,
	providerFailureDescriptor,
} from "./provider-failure.ts";

/** Each invocation owns failure capture for one summary attempt, including its split-turn request. */
export async function requestCompactionSummary(
	compactor: typeof compact,
	...args: Parameters<typeof compact>
): Promise<CompactResult> {
	const [preparation, models, model, instructions, signal, thinking, retry, callbacks] = args;
	let failure: ProviderFailure | undefined;
	// Explicit forwarding preserves the original receiver and checks the complete PI contract.
	const summaryModels: Models = {
		getProviders: models.getProviders.bind(models),
		getProvider: models.getProvider.bind(models),
		getModels: models.getModels.bind(models),
		getModel: models.getModel.bind(models),
		refresh: models.refresh.bind(models),
		checkAuth: models.checkAuth.bind(models),
		getAvailable: models.getAvailable.bind(models),
		getAuth: models.getAuth.bind(models),
		login: models.login.bind(models),
		logout: models.logout.bind(models),
		stream: models.stream.bind(models),
		complete: models.complete.bind(models),
		streamSimple: models.streamSimple.bind(models),
		fetchDeferred: models.fetchDeferred.bind(models),
		cancelDeferred: models.cancelDeferred.bind(models),
		completeSimple: async (selectedModel, context, options) => {
			failure = undefined;
			try {
				const response = await models.completeSimple(selectedModel, context, options);
				if (!signal?.aborted && !options?.signal?.aborted && response.stopReason === "error") {
					failure = annotateProviderFailure(selectedModel, response).providerFailure;
				}
				return response;
			} catch (error) {
				if (!signal?.aborted && !options?.signal?.aborted) failure = normalizeProviderFailure(selectedModel, error);
				throw error;
			}
		},
	};
	try {
		const result = await compactor(
			preparation,
			summaryModels,
			model,
			instructions,
			signal,
			thinking,
			retry,
			callbacks,
		);
		if (!result.ok) throw result.error;
		return result.value;
	} catch (error) {
		throw new ChatCompactionError(
			"chat_context_compaction_failed",
			error instanceof Error ? error.message : "Context compaction failed",
			{
				status: 502,
				cause: error,
				retryable: failure?.retryable ?? false,
				publicMessage: failure ? providerFailureDescriptor(failure, "compaction") : undefined,
			},
		);
	}
}
