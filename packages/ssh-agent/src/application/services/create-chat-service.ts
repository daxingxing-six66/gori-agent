import type { Models } from "@earendil-works/pi-ai";
import type { IdGenerator } from "../../domain/ids.ts";
import { ChatRunEventHub } from "../chat-run-event-hub.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import { ChatAgentEventHandler } from "./chat-agent-event-handler.ts";
import { ChatAgentRuntimeFactory, type ChatAgentRuntimeFactoryOptions } from "./chat-agent-runtime-factory.ts";
import { ChatApprovalService } from "./chat-approval-service.ts";
import type { ChatAttachmentService } from "./chat-attachment-service.ts";
import { ChatContextService } from "./chat-context-service.ts";
import { ChatQueueService } from "./chat-queue-service.ts";
import { ChatService } from "./chat-service.ts";
import { ChatToolAuthorizationPolicy } from "./chat-tool-authorization-policy.ts";
import { ChatToolCallCoordinator } from "./chat-tool-call-coordinator.ts";
import type { ContextCompactionSettingsService } from "./context-compaction-settings-service.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.ts";
import type { TerminalInteractionService } from "./terminal-interaction-service.ts";

export interface CreateChatServiceOptions {
	chatRepository: ChatRepository;
	chatAttachments: ChatAttachmentService;
	sessions: SessionRepository;
	models: Models;
	catalog: LlmModelCatalog;
	contextCompactionSettings?: ContextCompactionSettingsService;
	localCwd: string;
	ids: IdGenerator;
	approvalTimeoutMs?: number;
	createRemoteTool: ChatAgentRuntimeFactoryOptions["createRemoteTool"];
	createTerminalTool: ChatAgentRuntimeFactoryOptions["createTerminalTool"];
	bindServerInteraction(sessionId: string, runId: string, mode: "command" | "terminal"): Promise<string | null>;
	unbindTerminalRun(sessionId: string, runId: string): Promise<void>;
	terminalInteractions: TerminalInteractionService;
	createSftpTool: ChatAgentRuntimeFactoryOptions["createSftpTool"];
	createSftpDownloadTool: ChatAgentRuntimeFactoryOptions["createSftpDownloadTool"];
	preflightRemoteGuard(sessionId: string, command: string): Promise<{ allowed: boolean; reason?: string }>;
	lifecycle?: SessionLifecycleCoordinator;
	runtimeFactory?: Pick<ChatAgentRuntimeFactory, "create">;
}

export function createChatService(options: CreateChatServiceOptions): ChatService {
	const contextCompactionSettings = options.contextCompactionSettings ?? {
		get: () => ({ triggerPercent: 80, model: null, revision: 1, updatedAt: 0 }),
	};
	const events = new ChatRunEventHub();
	const approvals = new ChatApprovalService({
		repository: options.chatRepository,
		ids: options.ids,
		events,
		...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
	});
	const context = new ChatContextService({
		repository: options.chatRepository,
		models: options.models,
		catalog: options.catalog,
		ids: options.ids,
		events,
		attachments: options.chatAttachments,
	});
	const queues = new ChatQueueService({
		repository: options.chatRepository,
		ids: options.ids,
		events,
		attachments: options.chatAttachments,
	});
	const agentEvents = new ChatAgentEventHandler({
		repository: options.chatRepository,
		ids: options.ids,
		events,
		queues,
		catalog: options.catalog,
		terminalInteractions: options.terminalInteractions,
		onAssistantMessage: (runId, message) => context.recordProviderResponse(runId, message),
	});
	const toolCalls = new ChatToolCallCoordinator({
		authorization: new ChatToolAuthorizationPolicy({
			sessions: options.sessions,
			terminalInteractions: options.terminalInteractions,
			preflightRemoteGuard: options.preflightRemoteGuard,
		}),
		approvals,
	});
	const runtimeFactory =
		options.runtimeFactory ??
		new ChatAgentRuntimeFactory({
			models: options.models,
			toolCalls,
			queues,
			agentEvents,
			context,
			attachments: options.chatAttachments,
			createRemoteTool: options.createRemoteTool,
			createTerminalTool: options.createTerminalTool,
			createSftpTool: options.createSftpTool,
			createSftpDownloadTool: options.createSftpDownloadTool,
		});
	return new ChatService({
		chatRepository: options.chatRepository,
		sessions: options.sessions,
		models: options.models,
		catalog: options.catalog,
		localCwd: options.localCwd,
		ids: options.ids,
		bindServerInteraction: options.bindServerInteraction,
		unbindTerminalRun: options.unbindTerminalRun,
		events,
		approvals,
		context,
		contextCompactionSettings,
		queues,
		toolCalls,
		runtimeFactory,
		attachments: options.chatAttachments,
		...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
	});
}
