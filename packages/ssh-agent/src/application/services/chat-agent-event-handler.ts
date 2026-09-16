import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ChatError, type ChatRun } from "../../domain/chat.ts";
import type { IdGenerator } from "../../domain/ids.ts";
import type { ChatEventPublisher } from "../chat-run-event-hub.ts";
import { assistantFailure } from "../failure-policy.ts";
import { reportFailure } from "../failure-reporter.ts";
import type { ProviderFailureMessage } from "../provider-failure.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";
import { toToolExecutionUpdateEvent } from "../tool-update-protocol.ts";
import type { ChatQueueService } from "./chat-queue-service.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";
import type { TerminalInteractionService } from "./terminal-interaction-service.ts";

type MessageRepository = Pick<ChatRepository, "appendMessage">;
type QueueService = Pick<ChatQueueService, "consume">;
type ModelCatalog = Pick<LlmModelCatalog, "removeModel">;
type TerminalTimeline = Pick<TerminalInteractionService, "markLatestProcessing" | "markLatestFinished">;

export class ChatAgentEventHandler {
	readonly #repository: MessageRepository;
	readonly #ids: IdGenerator;
	readonly #events: ChatEventPublisher;
	readonly #queues: QueueService;
	readonly #catalog: ModelCatalog;
	readonly #terminalInteractions: TerminalTimeline;
	readonly #clock: () => number;
	readonly #onAssistantMessage: (runId: string, message: AssistantMessage) => void;

	constructor(options: {
		repository: MessageRepository;
		ids: IdGenerator;
		events: ChatEventPublisher;
		queues: QueueService;
		catalog: ModelCatalog;
		terminalInteractions: TerminalTimeline;
		clock?: () => number;
		onAssistantMessage?: (runId: string, message: AssistantMessage) => void;
	}) {
		this.#repository = options.repository;
		this.#ids = options.ids;
		this.#events = options.events;
		this.#queues = options.queues;
		this.#catalog = options.catalog;
		this.#terminalInteractions = options.terminalInteractions;
		this.#clock = options.clock ?? Date.now;
		this.#onAssistantMessage = options.onAssistantMessage ?? (() => undefined);
	}

	handle(run: ChatRun, event: AgentEvent, hooks: { onTurnStart(): void; onModelRemoved(): void }): void {
		if (event.type === "turn_start") {
			hooks.onTurnStart();
			if (run.serverInteractionMode === "terminal") {
				void this.#terminalInteractions.markLatestProcessing(run.id).catch((error) => {
					reportFailure(error, { stage: "terminal_projection", runId: run.id });
				});
			}
		}
		if (event.type === "message_end") {
			const originalMessage = event.message;
			let message = originalMessage;
			if (message.role === "assistant" && message.stopReason === "error") {
				const failure = assistantFailure(message, run);
				if (failure.code === "chat_model_not_supported") {
					this.#catalog.removeModel(run.providerId, run.modelId);
					hooks.onModelRemoved();
				}
				const protectedMessage: ProviderFailureMessage = {
					...message,
					failure,
					errorMessageDescriptor: { key: failure.messageKey!, values: failure.messageValues },
				};
				message = protectedMessage;
			}
			try {
				this.#repository.appendMessage(this.#ids.next(), run.sessionId, run.id, message, this.#clock());
			} catch (cause) {
				throw new ChatError("chat_persistence_failed", "Chat message could not be saved", 503, { cause });
			}
			if (message.role === "assistant") this.#onAssistantMessage(run.id, message);
			if (message.role === "assistant" && run.serverInteractionMode === "terminal") {
				void this.#terminalInteractions.markLatestFinished(run.id, String(message.timestamp)).catch((error) => {
					reportFailure(error, { stage: "terminal_projection", runId: run.id });
				});
			}
			if (originalMessage.role === "user") this.#queues.consume(run, originalMessage);
			if (message !== originalMessage) event = { ...event, message };
		}
		if (event.type === "tool_execution_update") {
			const update = toToolExecutionUpdateEvent(event);
			if (update !== undefined) this.#events.publish(run.id, event.type, update);
			return;
		}
		if (event.type === "message_update") {
			this.#events.publish(run.id, event.type, { assistantMessageEvent: event.assistantMessageEvent });
		} else {
			this.#events.publish(run.id, event.type, event);
		}
	}
}
