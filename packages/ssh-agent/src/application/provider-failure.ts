import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	normalizeContextOverflowError,
} from "@earendil-works/pi-ai";
import {
	normalizeProviderFailure,
	type ProviderFailureMessage,
	providerFailureDescriptor,
} from "./provider-failure-classification.ts";

export {
	isUnsupportedSelectedModel,
	normalizeProviderFailure,
	type ProviderFailure,
	type ProviderFailureMessage,
	providerFailureDescriptor,
} from "./provider-failure-classification.ts";

import { assistantFailure } from "./failure-policy.ts";
import { type FailureScope, linkFailureIdentity, reportFailure } from "./failure-reporter.ts";

export function annotateProviderFailure(
	model: Model<Api>,
	message: AssistantMessage,
	scope: FailureScope = { stage: "provider_request" },
): ProviderFailureMessage {
	if (message.stopReason !== "error") return message;
	const structured = message.diagnostics?.find((d) => d.type === "pi_messages_response_failure")?.details;
	const fallback = normalizeProviderFailure(model, message.errorMessage, "response");
	const failure =
		normalizeProviderFailure(
			model,
			{
				status: structured?.status ?? structured?.statusCode ?? fallback?.upstreamStatus,
				error: structured?.error,
				message: structured?.body,
			},
			"response",
		) ?? fallback;
	reportFailure(message, scope);
	const original = message;
	message = normalizeContextOverflowError(message, model.contextWindow);
	linkFailureIdentity(message, original);
	const result = failure
		? { ...message, providerFailure: failure, errorMessageDescriptor: providerFailureDescriptor(failure) }
		: message;
	linkFailureIdentity(result, message);
	const annotated = { ...result, failure: assistantFailure(result) };
	linkFailureIdentity(annotated, result);
	return annotated;
}

/** Preserve the original event protocol and partial output, including on iteration failures. */
export function providerFailureStream(
	model: Model<Api>,
	start: () => AssistantMessageEventStream,
	signal?: AbortSignal,
	scope: FailureScope = { stage: "provider_request" },
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		let partial: AssistantMessage | undefined;
		try {
			for await (const event of start()) {
				if ("partial" in event) partial = event.partial;
				if (event.type === "error") {
					output.push({
						...event,
						error: signal?.aborted ? event.error : annotateProviderFailure(model, event.error, scope),
					});
					return;
				}
				output.push(event);
				if (event.type === "done") return;
			}
			throw new Error("Provider stream ended without a terminal event");
		} catch (error) {
			reportFailure(error, scope);
			const failure = signal?.aborted ? undefined : normalizeProviderFailure(model, error);
			const message: ProviderFailureMessage = {
				...(partial ?? {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				}),
				stopReason: signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : "Model request failed",
				...(failure
					? { providerFailure: failure, errorMessageDescriptor: providerFailureDescriptor(failure) }
					: {}),
			};
			linkFailureIdentity(message, error);
			const normalized = normalizeContextOverflowError(message, model.contextWindow);
			Object.assign(message, normalized);
			if (!signal?.aborted) message.failure = assistantFailure(message);
			output.push({ type: "error", reason: signal?.aborted ? "aborted" : "error", error: message });
		}
	})();
	return output;
}
