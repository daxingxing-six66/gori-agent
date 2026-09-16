import {
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	AgentRunError,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ChatRun } from "../domain/chat.ts";
import { ChatCompactionError } from "../domain/context-compaction.ts";
import { assistantFailure, runFailure } from "./failure-policy.ts";
import type { ProviderFailureMessage } from "./provider-failure.ts";
import type { ChatQueueDriver } from "./services/chat-queue-service.ts";

const COMPACTION_AGENT_CODES = {
	chat_context_overflow: "context_overflow",
	chat_context_no_compactable_history: "context_compaction_failed",
	chat_credential_check_failed: "compaction_model_unavailable",
	chat_context_compaction_insufficient: "context_compaction_insufficient",
	chat_context_compaction_failed: "context_compaction_failed",
	chat_compaction_model_unavailable: "compaction_model_unavailable",
} as const satisfies Record<ChatCompactionError["code"], string>;

export class ChatRunRuntime implements ChatQueueDriver {
	#failure?: NonNullable<ChatRun["failure"]>;

	beginProviderRequest(): void {
		if (this.#failure?.stage === "recovery") this.#failure = undefined;
	}

	captureFailure(error: unknown, stage = "agent"): void {
		if (this.cancellationRequested && error instanceof Error && error.name === "AbortError") return;
		this.#failure ??= runFailure(error, { stage, runId: this.run.id, sessionId: this.run.sessionId });
	}

	toAgentError(error: unknown, original?: ProviderFailureMessage): Error {
		const recovery = runFailure(error, {
			stage: "recovery",
			runId: this.run.id,
			sessionId: this.run.sessionId,
			rootErrorId: original ? assistantFailure(original).errorId : undefined,
		});
		this.#failure = original
			? {
					...assistantFailure(original),
					recovery: {
						errorId: recovery.errorId!,
						code: recovery.code,
						message: recovery.message,
						messageKey: recovery.messageKey,
						messageValues: recovery.messageValues,
					},
				}
			: recovery;
		const code =
			error instanceof ChatCompactionError ? COMPACTION_AGENT_CODES[error.code] : "context_compaction_failed";
		return new AgentRunError(code, error instanceof Error ? error.message : String(error), { cause: error });
	}

	annotateFailure(event: AgentEvent): void {
		const messages =
			event.type === "agent_end" ? event.messages.slice(-1) : "message" in event ? [event.message] : [];
		for (const message of messages) {
			if (message.role === "assistant" && message.stopReason === "error") {
				Object.assign(message, { failure: this.#failure ?? assistantFailure(message) });
			}
		}
	}

	get publicFailure(): NonNullable<ChatRun["failure"]> | undefined {
		if (this.#failure) return this.#failure;
		const last = this.#agent.state.messages.at(-1);
		if (last?.role !== "assistant" || last.stopReason !== "error") return undefined;
		return assistantFailure(last);
	}
	readonly run: ChatRun;
	readonly #agent: Agent;
	readonly #env: NodeExecutionEnv;
	readonly #loadContextMessages?: () => AgentMessage[];
	#terminationState: "active" | "cancelling" = "active";
	#continuationState: "automatic" | "stop_after_turn" = "automatic";
	#steeringState: "accepting" | "reject_until_next_turn" = "accepting";
	#modelState: "available" | "removed" = "available";
	#disposePromise?: Promise<void>;

	constructor(input: {
		run: ChatRun;
		agent: Agent;
		env: NodeExecutionEnv;
		loadContextMessages?: () => AgentMessage[];
	}) {
		this.run = input.run;
		this.#agent = input.agent;
		this.#env = input.env;
		this.#loadContextMessages = input.loadContextMessages;
	}

	get acceptsSteering(): boolean {
		return this.#steeringState === "accepting";
	}

	get cancellationRequested(): boolean {
		return this.#terminationState === "cancelling";
	}

	get modelRemoved(): boolean {
		return this.#modelState === "removed";
	}

	get errorMessage(): string | undefined {
		return this.#agent.state.errorMessage;
	}

	get errorCode(): string | undefined {
		const message = this.#agent.state.messages.at(-1);
		if (message?.role !== "assistant" || message.stopReason !== "error") return undefined;
		const attachmentFailure = message.diagnostics?.find(
			(diagnostic) => diagnostic.type === "ssh_agent_attachment_input_failure",
		)?.details?.code;
		return typeof attachmentFailure === "string" ? attachmentFailure : message.errorCode;
	}

	get model(): Model<Api> {
		return this.#agent.state.model;
	}

	get context(): AgentContext {
		const state = this.#agent.state;
		// Agent transcript retains pre-compaction history; the persisted boundary defines effective messages.
		return {
			systemPrompt: state.systemPrompt,
			tools: [...state.tools],
			messages: this.#loadContextMessages?.() ?? [...state.messages],
		};
	}

	prompt(message: AgentMessage): Promise<void> {
		return this.#agent.prompt(message);
	}

	requestCancellation(): void {
		this.#terminationState = "cancelling";
	}

	stopAfterApprovalRejection(): void {
		this.#continuationState = "stop_after_turn";
		this.#steeringState = "reject_until_next_turn";
	}

	beginTurn(): void {
		this.#steeringState = "accepting";
	}

	consumeContinuationDecision(): boolean {
		if (this.#continuationState !== "stop_after_turn") return true;
		this.#continuationState = "automatic";
		return false;
	}

	markModelRemoved(): void {
		this.#modelState = "removed";
	}

	abortAgent(): void {
		this.#agent.abort();
	}

	steer(message: AgentMessage): void {
		this.#agent.steer(message);
	}

	followUp(message: AgentMessage): void {
		this.#agent.followUp(message);
	}

	clearSteeringQueue(): void {
		this.#agent.clearSteeringQueue();
	}

	clearFollowUpQueue(): void {
		this.#agent.clearFollowUpQueue();
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= this.#disposeResources();
		return this.#disposePromise;
	}

	async #disposeResources(): Promise<void> {
		try {
			this.#agent.abort();
		} finally {
			await this.#env.cleanup();
		}
	}
}
