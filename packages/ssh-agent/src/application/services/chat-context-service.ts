import {
	type AgentMessage,
	type CompactResult,
	compact,
	convertToLlm,
	estimateTokens,
	prepareCompaction,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, estimateContextTokens, type Model, type Models } from "@earendil-works/pi-ai";
import type { ChatMessageProjection, ChatRun } from "../../domain/chat.ts";
import type { ChatContextUsage } from "../../domain/chat-context-usage.ts";
import {
	ChatCompactionError,
	type ChatCompactionReason,
	type ChatCompactionSettings,
	type StoredChatCompactionMessage,
} from "../../domain/context-compaction.ts";
import type { IdGenerator } from "../../domain/ids.ts";
import type { ChatContext } from "../chat-context.ts";
import type { ChatEventPublisher } from "../chat-run-event-hub.ts";
import { CHAT_COMPACTION_RESERVE_TOKEN_CAP } from "../chat-runtime-defaults.ts";
import { requestCompactionSummary } from "../compaction-summary-request.ts";
import { runFailure } from "../failure-policy.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";
import type { ChatAttachmentService } from "./chat-attachment-service.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";
import { addOpenCodeGoSessionHeaders } from "./opencode-go-session.ts";

const TARGET_PERCENT = 30;
const MINIMUM_REDUCTION_PERCENT = 30;
const SECOND_ATTEMPT_KEEP_RECENT_PERCENT = 50;
const CALIBRATION_ALPHA = 0.2;
const CALIBRATION_MIN = 1;
const CALIBRATION_MAX = 2;

type ContextRepository = Pick<ChatRepository, "appendCompaction" | "latestCompaction" | "listMessages">;

interface EstimateSnapshot {
	raw: number;
	factor: number;
	corrected: number;
}

export interface ChatCompactionOutcome<T extends ChatContext = ChatContext> {
	status: "not_needed" | "nothing_to_compact" | "completed";
	attempts: 0 | 1 | 2;
	context: T;
	message?: ChatMessageProjection;
	tokensBefore: number;
	estimatedTokensAfter: number;
	reductionPercent: number;
	model?: { providerId: string; modelId: string; fallback: boolean };
}

export class ChatContextService {
	readonly #repository: ContextRepository;
	readonly #models: Models;
	readonly #catalog: Pick<LlmModelCatalog, "getModel">;
	readonly #ids: IdGenerator;
	readonly #events: ChatEventPublisher;
	readonly #attachments: Pick<ChatAttachmentService, "compactionProjection" | "restoreCompactionMessage">;
	readonly #clock: () => number;
	readonly #compact: typeof compact;
	readonly #calibration = new Map<string, number>();
	readonly #pendingEstimates = new Map<string, { modelKey: string; raw: number }>();
	readonly #log: (event: Record<string, unknown>) => void;

	constructor(options: {
		repository: ContextRepository;
		models: Models;
		catalog: Pick<LlmModelCatalog, "getModel">;
		ids: IdGenerator;
		events: ChatEventPublisher;
		attachments: Pick<ChatAttachmentService, "compactionProjection" | "restoreCompactionMessage">;
		clock?: () => number;
		compact?: typeof compact;
		log?: (event: Record<string, unknown>) => void;
	}) {
		this.#repository = options.repository;
		this.#models = options.models;
		this.#catalog = options.catalog;
		this.#ids = options.ids;
		this.#events = options.events;
		this.#attachments = options.attachments;
		this.#clock = options.clock ?? Date.now;
		this.#compact = options.compact ?? compact;
		this.#log =
			options.log ??
			((event) => {
				if (event.type === "compaction.failed") console.error("[ssh-agent.compaction]", event);
				else console.info("[ssh-agent.compaction]", JSON.stringify(event));
			});
	}

	load(sessionId: string): AgentMessage[] {
		const entry = this.#repository.latestCompaction(sessionId);
		if (!entry) return this.#repository.listMessages(sessionId).map((message) => message.message);
		return [
			entry.message,
			...entry.message.retainedTail,
			...this.#repository.listMessages(sessionId, entry.sequence).map((message) => message.message),
		];
	}

	recordProviderRequest(runId: string, model: Model<Api>, context: ChatContext): EstimateSnapshot {
		const estimate = this.estimate(model, context);
		this.#pendingEstimates.set(runId, { modelKey: modelKey(model), raw: estimate.raw });
		return estimate;
	}

	recordProviderResponse(runId: string, message: AssistantMessage): void {
		const pending = this.#pendingEstimates.get(runId);
		this.#pendingEstimates.delete(runId);
		if (!pending || message.stopReason === "error" || message.stopReason === "aborted") return;
		const actual = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (pending.raw <= 0 || actual <= 0) return;
		const previous = this.#calibration.get(pending.modelKey) ?? 1;
		const observed = actual / pending.raw;
		const next = clamp(
			previous * (1 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA,
			CALIBRATION_MIN,
			CALIBRATION_MAX,
		);
		this.#calibration.set(pending.modelKey, next);
		this.#log({
			type: "calibration.updated",
			model: pending.modelKey,
			rawEstimate: pending.raw,
			actualInput: actual,
			factor: next,
		});
	}

	estimate(model: Model<Api>, context: ChatContext): EstimateSnapshot {
		const raw = estimateContextTokens({
			systemPrompt: context.systemPrompt,
			messages: convertToLlm(context.messages.map((message) => this.#attachments.compactionProjection(message))),
			tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
		}).tokens;
		const factor = this.#calibration.get(modelKey(model)) ?? 1;
		return { raw, factor, corrected: Math.ceil(raw * factor) };
	}

	usage(model: Model<Api>, context: ChatContext): ChatContextUsage {
		const contextTokens = this.estimate(model, context).corrected;
		return {
			contextTokens,
			contextWindow: model.contextWindow,
			usagePercent: Math.round((contextTokens / model.contextWindow) * 10_000) / 100,
			source: "estimated",
			providerId: model.provider,
			modelId: model.id,
		};
	}

	publishUsage(run: ChatRun, model: Model<Api>, context: ChatContext): void {
		this.#events.publish(run.id, "context.updated", this.usage(model, context));
	}

	async compactContext<T extends ChatContext>(input: {
		sessionId: string;
		run: ChatRun | null;
		context: T;
		sessionModel: Model<Api>;
		settings: ChatCompactionSettings;
		reason: ChatCompactionReason;
		force: boolean;
		signal?: AbortSignal;
	}): Promise<ChatCompactionOutcome<T>> {
		const thresholdTokens = Math.floor(input.sessionModel.contextWindow * (input.settings.triggerPercent / 100));
		const initialEstimate = this.estimate(input.sessionModel, input.context);
		if (
			!input.force &&
			!shouldCompact(initialEstimate.corrected, input.sessionModel.contextWindow, {
				enabled: true,
				reserveTokens: input.sessionModel.contextWindow - thresholdTokens,
				keepRecentTokens: 0,
			})
		) {
			return {
				status: "not_needed",
				attempts: 0,
				context: input.context,
				tokensBefore: initialEstimate.corrected,
				estimatedTokensAfter: initialEstimate.corrected,
				reductionPercent: 0,
			};
		}

		let context = input.context;
		let beforeAttempt = initialEstimate.corrected;
		let lastAttempt: 1 | 2 = 1;
		for (const attempt of [1, 2] as const) {
			lastAttempt = attempt;
			const reserveTokens = Math.min(
				CHAT_COMPACTION_RESERVE_TOKEN_CAP,
				Math.max(1, Math.floor(input.sessionModel.contextWindow * 0.2)),
			);
			const targetTokens = Math.max(1, Math.floor(input.sessionModel.contextWindow * (TARGET_PERCENT / 100)));
			const keepRecentTokens =
				attempt === 1
					? targetTokens
					: Math.max(1, Math.floor(targetTokens * (SECOND_ATTEMPT_KEEP_RECENT_PERCENT / 100)));
			const projections = this.#repository.listMessages(input.sessionId);
			const projectionAttachments = projections.flatMap((projection) => projection.attachments ?? []);
			const entries = projections.map((projection, index) =>
				toCompactionEntry(projection, index === 0 ? null : projections[index - 1]!.id, (message) =>
					this.#attachments.compactionProjection(message, projectionAttachments),
				),
			);
			const projectedMessages = context.messages.map((message) =>
				this.#attachments.compactionProjection(message, projectionAttachments),
			);
			const usageEstimate = estimateContextTokens(convertToLlm(projectedMessages));
			const usageRequiresCompaction =
				usageEstimate.lastUsageIndex !== null && usageEstimate.tokens > keepRecentTokens;
			const messageEstimate = projectedMessages.reduce((total, message) => total + estimateTokens(message), 0);
			// Usage is authoritative for the current payload. Character estimates only
			// distribute the retention budget; they must not veto a known excess.
			const cutBudget = usageRequiresCompaction
				? Math.max(1, Math.floor(keepRecentTokens * Math.min(1, messageEstimate / usageEstimate.tokens)))
				: keepRecentTokens;
			const preparation = prepareCompaction(
				entries,
				{ enabled: true, reserveTokens, keepRecentTokens: cutBudget },
				{ allowLatestCompaction: attempt === 2 },
			);
			if (!preparation.ok) {
				this.#fail(
					input.run,
					input.reason,
					attempt,
					new ChatCompactionError("chat_context_compaction_failed", preparation.error.message, {
						cause: preparation.error,
					}),
				);
			}
			if (
				!preparation.value ||
				(preparation.value.messagesToSummarize.length === 0 && preparation.value.turnPrefixMessages.length === 0)
			) {
				if (attempt === 1 && input.reason === "manual" && !usageRequiresCompaction) {
					return {
						status: "nothing_to_compact",
						attempts: 0,
						context,
						tokensBefore: initialEstimate.corrected,
						estimatedTokensAfter: initialEstimate.corrected,
						reductionPercent: 0,
					};
				}
				this.#fail(
					input.run,
					input.reason,
					attempt,
					new ChatCompactionError("chat_context_no_compactable_history", "Context has no compactable history"),
				);
			}

			let effectiveModel: { model: Model<Api>; fallback: boolean };
			try {
				effectiveModel = await this.#resolveModel(
					input.settings,
					input.sessionModel,
					preparation.value.tokensBefore,
				);
			} catch (error) {
				if (error instanceof ChatCompactionError) this.#fail(input.run, input.reason, attempt, error);
				throw error;
			}
			this.#publish(input.run, "compaction.started", {
				reason: input.reason,
				attempt,
				tokensBefore: beforeAttempt,
				thresholdTokens,
				model: modelDescriptor(effectiveModel),
			});
			const requestEstimate = this.estimate(input.sessionModel, context);
			this.#log({
				type: "compaction.started",
				reason: input.reason,
				attempt,
				contextWindow: input.sessionModel.contextWindow,
				thresholdTokens,
				rawEstimate: requestEstimate.raw,
				calibrationFactor: requestEstimate.factor,
				correctedEstimate: beforeAttempt,
				usageTokens: usageEstimate.usageTokens,
				messageEstimate,
				keepRecentTokens,
				cutBudget,
				model: modelKey(effectiveModel.model),
			});
			let result: CompactResult;
			try {
				const compactionHeaders = addOpenCodeGoSessionHeaders(
					effectiveModel.model,
					input.sessionId,
					effectiveModel.model.headers,
				);
				const compactionModel =
					compactionHeaders === effectiveModel.model.headers
						? effectiveModel.model
						: { ...effectiveModel.model, headers: compactionHeaders };
				result = await requestCompactionSummary(
					this.#compact,
					preparation.value,
					this.#models,
					compactionModel,
					undefined,
					input.signal,
					input.run?.thinkingLevel,
				);
			} catch (error) {
				if (error instanceof ChatCompactionError) this.#fail(input.run, input.reason, attempt, error);
				throw error;
			}
			const timestamp = this.#clock();
			const message: StoredChatCompactionMessage = {
				role: "compactionSummary",
				summary: result.summary,
				retainedTail: result.retainedTail.map((entry) => this.#attachments.restoreCompactionMessage(entry)),
				tokensBefore: result.tokensBefore,
				details: result.details,
				usage: result.usage,
				reason: input.reason,
				attempt,
				provider: effectiveModel.model.provider,
				model: effectiveModel.model.id,
				timestamp,
			};
			const latestMessage = this.#repository.appendCompaction(
				this.#ids.next(),
				input.sessionId,
				input.run?.id ?? null,
				message,
				timestamp,
			);
			context = { ...context, messages: this.load(input.sessionId) };
			const after = this.estimate(input.sessionModel, context).corrected;
			const reductionPercent = reduction(beforeAttempt, after);
			this.#publish(input.run, "compaction.completed", {
				reason: input.reason,
				attempt,
				messageId: latestMessage.id,
				sequence: latestMessage.sequence,
				tokensBefore: beforeAttempt,
				estimatedTokensAfter: after,
				reductionPercent,
				model: modelDescriptor(effectiveModel),
			});
			if (input.run) this.publishUsage(input.run, input.sessionModel, context);
			this.#log({
				type: "compaction.completed",
				reason: input.reason,
				attempt,
				tokensBefore: beforeAttempt,
				estimatedTokensAfter: after,
				reductionPercent,
			});
			if (after <= thresholdTokens) {
				return {
					status: "completed",
					attempts: attempt,
					context,
					message: latestMessage,
					tokensBefore: initialEstimate.corrected,
					estimatedTokensAfter: after,
					reductionPercent: reduction(initialEstimate.corrected, after),
					model: modelDescriptor(effectiveModel),
				};
			}
			if (attempt === 1 && reductionPercent >= MINIMUM_REDUCTION_PERCENT) {
				beforeAttempt = after;
				continue;
			}
			break;
		}

		this.#fail(
			input.run,
			input.reason,
			lastAttempt,
			new ChatCompactionError(
				"chat_context_compaction_insufficient",
				"Context remains above the configured threshold after compaction",
			),
		);
	}

	async #resolveModel(
		settings: ChatCompactionSettings,
		sessionModel: Model<Api>,
		tokensBefore: number,
	): Promise<{ model: Model<Api>; fallback: boolean }> {
		if (settings.model) {
			const selected = this.#catalog.getModel(settings.model.providerId, settings.model.modelId);
			if (selected && selected.contextWindow > tokensBefore && (await this.#hasAuth(selected.provider))) {
				return { model: selected, fallback: false };
			}
			this.#log({
				type: "compaction.model_fallback",
				configuredModel: settings.model,
				sessionModel: modelKey(sessionModel),
			});
		}
		if (!(await this.#hasAuth(sessionModel.provider))) {
			throw new ChatCompactionError(
				"chat_compaction_model_unavailable",
				"No available model can perform context compaction",
			);
		}
		return { model: sessionModel, fallback: settings.model !== null };
	}

	#publish(run: ChatRun | null, type: string, data: unknown): void {
		if (run) this.#events.publish(run.id, type, data);
	}

	async #hasAuth(providerId: string): Promise<boolean> {
		try {
			return (await this.#models.checkAuth(providerId)) !== undefined;
		} catch (error) {
			throw new ChatCompactionError("chat_credential_check_failed", "Could not check model credentials", {
				cause: error,
				status: 502,
			});
		}
	}

	#fail(run: ChatRun | null, reason: ChatCompactionReason, attempt: 1 | 2, error: ChatCompactionError): never {
		const failure = runFailure(error, { stage: "recovery", runId: run?.id, sessionId: run?.sessionId });
		this.#publish(run, "compaction.failed", { ...failure, reason, attempt });
		throw error;
	}
}

function toCompactionEntry(
	projection: ChatMessageProjection,
	parentId: string | null,
	project: (message: AgentMessage) => AgentMessage,
) {
	const message = projection.message;
	if (message.role === "compactionSummary" && "retainedTail" in message) {
		const compactMessage = message as StoredChatCompactionMessage;
		return {
			type: "compaction" as const,
			id: projection.id,
			seq: projection.sequence,
			parentId,
			timestamp: projection.createdAt,
			summary: compactMessage.summary,
			retainedTail: compactMessage.retainedTail.map(project),
			tokensBefore: compactMessage.tokensBefore,
			details: compactMessage.details,
			usage: compactMessage.usage,
		};
	}
	return {
		type: "message" as const,
		id: projection.id,
		seq: projection.sequence,
		parentId,
		timestamp: projection.createdAt,
		message: project(message),
	};
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function modelDescriptor(value: { model: Model<Api>; fallback: boolean }) {
	return { providerId: value.model.provider, modelId: value.model.id, fallback: value.fallback };
}

function reduction(before: number, after: number): number {
	return before <= 0 ? 0 : Math.max(0, ((before - after) / before) * 100);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
