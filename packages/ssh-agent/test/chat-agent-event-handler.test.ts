import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ChatEventPublisher } from "../src/application/chat-run-event-hub.ts";
import type { ChatRepository } from "../src/application/repositories/chat-repository.ts";
import { ChatAgentEventHandler } from "../src/application/services/chat-agent-event-handler.ts";
import type { ChatQueueService } from "../src/application/services/chat-queue-service.ts";
import type { LlmModelCatalog } from "../src/application/services/llm-model-catalog.ts";
import type { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import type { ChatRun } from "../src/domain/chat.ts";

const commandRun: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "request-1",
	providerId: "provider-1",
	modelId: "model-1",
	thinkingLevel: "off",
	serverInteractionMode: "command",
	terminalSessionId: null,
	status: "running",
	createdAt: 1,
	updatedAt: 1,
};

function createContext() {
	const repository = { appendMessage: vi.fn() } satisfies Pick<ChatRepository, "appendMessage">;
	const events = { publish: vi.fn() } satisfies ChatEventPublisher;
	const queues = { consume: vi.fn() } satisfies Pick<ChatQueueService, "consume">;
	const catalog = { removeModel: vi.fn(() => true) } satisfies Pick<LlmModelCatalog, "removeModel">;
	const terminalInteractions = {
		markLatestProcessing: vi.fn(async () => undefined),
		markLatestFinished: vi.fn(async () => undefined),
	} satisfies Pick<TerminalInteractionService, "markLatestProcessing" | "markLatestFinished">;
	const handler = new ChatAgentEventHandler({
		repository,
		ids: { next: () => "message-1" },
		events,
		queues,
		catalog,
		terminalInteractions,
		clock: () => 100,
	});
	return { handler, repository, events, queues, catalog, terminalInteractions };
}

function hooks() {
	return { onTurnStart: vi.fn(), onModelRemoved: vi.fn() };
}

describe("ChatAgentEventHandler", () => {
	it("marks Terminal processing when a turn starts", () => {
		const context = createContext();
		const eventHooks = hooks();
		const terminalRun: ChatRun = {
			...commandRun,
			serverInteractionMode: "terminal",
			terminalSessionId: "terminal-1",
		};

		context.handler.handle(terminalRun, { type: "turn_start" }, eventHooks);

		expect(eventHooks.onTurnStart).toHaveBeenCalledOnce();
		expect(context.terminalInteractions.markLatestProcessing).toHaveBeenCalledWith("run-1");
		expect(context.events.publish).toHaveBeenCalledWith("run-1", "turn_start", { type: "turn_start" });
	});

	it("removes an unsupported selected model and persists the user-facing failure", () => {
		const context = createContext();
		const eventHooks = hooks();
		const message: AgentMessage = {
			...fauxAssistantMessage("", { stopReason: "error", timestamp: 42 }),
			diagnostics: [
				{
					type: "pi_messages_response_failure",
					timestamp: 42,
					details: {
						provider: "provider-1",
						model: "model-1",
						body: '{"type":"ModelError","message":"Model model-1 is not supported"}',
					},
				},
			],
		};

		context.handler.handle(commandRun, { type: "message_end", message }, eventHooks);

		expect(context.catalog.removeModel).toHaveBeenCalledWith("provider-1", "model-1");
		expect(eventHooks.onModelRemoved).toHaveBeenCalledOnce();
		expect(context.repository.appendMessage).toHaveBeenCalledWith(
			"message-1",
			"session-1",
			"run-1",
			expect.objectContaining({
				role: "assistant",
				failure: expect.objectContaining({
					code: "chat_model_not_supported",
					message: "The selected model is no longer supported and was removed. Select another model.",
				}),
				errorMessageDescriptor: { key: "chat.model_not_supported" },
			}),
			100,
		);
		expect(context.events.publish).toHaveBeenCalledWith(
			"run-1",
			"message_end",
			expect.objectContaining({
				type: "message_end",
				message: expect.objectContaining({
					failure: expect.objectContaining({
						code: "chat_model_not_supported",
						message: "The selected model is no longer supported and was removed. Select another model.",
					}),
					errorMessageDescriptor: { key: "chat.model_not_supported" },
				}),
			}),
		);
	});

	it("consumes a queued user message after persistence", () => {
		const context = createContext();
		const message: AgentMessage = { role: "user", content: "continue", timestamp: 20 };

		context.handler.handle(commandRun, { type: "message_end", message }, hooks());

		expect(context.repository.appendMessage).toHaveBeenCalledWith("message-1", "session-1", "run-1", message, 100);
		expect(context.queues.consume).toHaveBeenCalledWith(commandRun, message);
	});

	it("keeps Provider failure diagnostics internally and exposes a safe presentation descriptor", () => {
		const context = createContext();
		const message = {
			...fauxAssistantMessage("", { stopReason: "error", timestamp: 42 }),
			errorMessage: "provider response included a secret",
		};

		context.handler.handle(commandRun, { type: "message_end", message }, hooks());

		expect(context.repository.appendMessage).toHaveBeenCalledWith(
			"message-1",
			"session-1",
			"run-1",
			expect.objectContaining({
				errorMessage: "provider response included a secret",
				errorMessageDescriptor: { key: "chat.run_failed" },
			}),
			100,
		);
		expect(context.events.publish).toHaveBeenCalledWith(
			"run-1",
			"message_end",
			expect.objectContaining({
				message: expect.objectContaining({ errorMessageDescriptor: { key: "chat.run_failed" } }),
			}),
		);
	});

	it("publishes only the projected Tool update protocol", () => {
		const context = createContext();
		const event: Extract<AgentEvent, { type: "tool_execution_update" }> = {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "bash",
			args: { secret: "not transported" },
			partialResult: {
				content: [{ type: "text", text: "visible output" }],
				details: { privateValue: "not transported" },
			},
		};

		context.handler.handle(commandRun, event, hooks());

		expect(context.events.publish).toHaveBeenCalledWith("run-1", "tool_execution_update", {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "bash",
			update: { type: "text", detail: { content: "visible output", mode: "replace" } },
		});
	});

	it("publishes only the Assistant stream delta for message updates", () => {
		const context = createContext();
		const message = fauxAssistantMessage("partial", { timestamp: 30 });
		const assistantMessageEvent = { type: "start", partial: message } as const;

		context.handler.handle(commandRun, { type: "message_update", message, assistantMessageEvent }, hooks());

		expect(context.events.publish).toHaveBeenCalledWith("run-1", "message_update", {
			assistantMessageEvent,
		});
	});
});
