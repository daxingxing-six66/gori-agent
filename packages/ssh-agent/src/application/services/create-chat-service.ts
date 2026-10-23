import type { RemoteSandboxApprovalStore } from "./remote-sandbox-approval-store.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { IdGenerator } from "../../domain/ids.ts";
import { ChatRunEventHub } from "../chat-run-event-hub.ts";
import { SessionActivityService } from "../session-activity/session-activity-service.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import { ChatAgentEventHandler } from "./chat-agent-event-handler.ts";
import { ChatAgentRuntimeFactory, type ChatAgentRuntimeFactoryOptions } from "./chat-agent-runtime-factory.ts";
import { ChatApprovalService } from "./chat-approval-service.ts";
import type { ChatAttachmentService } from "./chat-attachment-service.ts";
import { ChatContextService } from "./chat-context-service.ts";
import type { ChatPromptService } from "./chat-prompt-service.ts";
import { ChatQueueService } from "./chat-queue-service.ts";
import { ChatService } from "./chat-service.ts";
import { ChatUserDecisionService } from "./chat-user-decision-service.ts";
import { ChatToolAuthorizationPolicy } from "./chat-tool-authorization-policy.ts";
import { ChatToolCallCoordinator } from "./chat-tool-call-coordinator.ts";
import type { ContextCompactionSettingsService } from "./context-compaction-settings-service.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";
import type { SessionTitleService } from "./session-title-service.ts";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.ts";
import type { TerminalInteractionService } from "./terminal-interaction-service.ts";
import type { AgentDeploymentService } from "../tools/deployment-agent-tool.ts";
import type { BubblewrapInstallationService } from "./bubblewrap-installation-service.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { RemoteSandboxRoute } from "./remote-sandbox-routing.ts";
import { SessionSandboxPolicy } from "./session-sandbox-policy.ts";
import type { RuntimeContextRepository } from "../repositories/runtime-context-repository.ts";
import { ChatRuntimeContextService } from "./chat-runtime-context-service.ts";
import { ChatRuntimeFacts } from "./chat-runtime-facts.ts";
import type { DiagnoseRuntime } from "../diagnose-runtime.ts";

export interface CreateChatServiceOptions {
	prompts: ChatPromptService;
	titles?: SessionTitleService;
	chatRepository: ChatRepository;
	runtimeContexts?: RuntimeContextRepository;
	terminalFacts?: ChatAgentRuntimeFactoryOptions["terminalFacts"];
	terminalHumanFacts?: ChatAgentRuntimeFactoryOptions["terminalHumanFacts"];
	chatAttachments: ChatAttachmentService;
	sessions: SessionRepository;
	models: Models;
	catalog: LlmModelCatalog;
	contextCompactionSettings?: ContextCompactionSettingsService;
	sandboxApprovals?: RemoteSandboxApprovalStore;
	localCwd: string;
	deploymentSetupInstructions?: (sessionId: string) => Promise<string>;
	deployments?: AgentDeploymentService;
	diagnoses?: DiagnoseRuntime;
	previewDeploymentRemoteStage?: (sessionId: string, deploymentRunId: string,
		stage: "restart" | "verify") => { readonly command: string; readonly mode: "workspace_write" | "full_access"; readonly sessionAuthorized?: boolean } | undefined;
	resolveRemoteTarget?: (sessionId: string) => Promise<SshTargetSnapshot>;
	bubblewrapInstallations?: BubblewrapInstallationService;
	assessRemoteSandbox?: (sessionId: string, declaredWritePaths: readonly string[], signal: AbortSignal) =>
		Promise<{ readonly target: SshTargetSnapshot; readonly route: RemoteSandboxRoute }>;
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
	const runtimeContexts = options.runtimeContexts ? new ChatRuntimeContextService(options.runtimeContexts) : undefined;
	const sandboxPolicy = new SessionSandboxPolicy(options.sessions);
	const runtimeFacts = new ChatRuntimeFacts({ sandboxPolicy, diagnoses: options.diagnoses, deployments: options.deployments, terminalFacts: options.terminalFacts, terminalHumanFacts: options.terminalHumanFacts });
	const events = new ChatRunEventHub();
	const activity = new SessionActivityService(events);
	const approvals = new ChatApprovalService({
		repository: options.chatRepository,
		ids: options.ids,
		events,
		...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
	});
	const decisions = new ChatUserDecisionService({ repository: options.chatRepository, ids: options.ids, events });
	const context = new ChatContextService({
		runtimeContexts: options.runtimeContexts,
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
	const authorization = new ChatToolAuthorizationPolicy({
		sessions: options.sessions,
		terminalInteractions: options.terminalInteractions,
		preflightRemoteGuard: options.preflightRemoteGuard,
		requireBubblewrapInstallation: options.bubblewrapInstallations === undefined ? undefined
			: (sessionId, signal) => options.bubblewrapInstallations!.requireInstallation(sessionId, signal),
		sandboxApprovals: options.sandboxApprovals,
		assessRemoteSandbox: options.assessRemoteSandbox,
		previewDeploymentRemoteStage: options.previewDeploymentRemoteStage,
		resolveRemoteTarget: options.resolveRemoteTarget,
	});
	const toolCalls = new ChatToolCallCoordinator({
		authorization,
		approvals,
	});
	const runtimeFactory =
		options.runtimeFactory ??
		new ChatAgentRuntimeFactory({
			sandboxPolicy,
			runtimeContexts,
			runtimeFacts,
			terminalFacts: options.terminalFacts,
			terminalInteractions: options.terminalInteractions,
			models: options.models,
			toolCalls,
			queues,
			agentEvents,
			context,
			attachments: options.chatAttachments,
			decisions,
			deployments: options.deployments,
			diagnoses: options.diagnoses,
			bubblewrapInstallations: options.bubblewrapInstallations,
			createRemoteTool: options.createRemoteTool,
			createTerminalTool: options.createTerminalTool,
			createSftpTool: options.createSftpTool,
			createSftpDownloadTool: options.createSftpDownloadTool,
		});
	return new ChatService({
		runtimeContexts,
		runtimeFacts,
		prompts: options.prompts,
		...(options.titles ? { titles: options.titles } : {}),
		chatRepository: options.chatRepository,
		sessions: options.sessions,
		models: options.models,
		catalog: options.catalog,
		localCwd: options.localCwd,
		...(options.deploymentSetupInstructions === undefined ? {} : { deploymentSetupInstructions: options.deploymentSetupInstructions }),
		...(options.deployments === undefined ? {} : { deployments: options.deployments }),
		...(options.diagnoses ? { diagnoses: options.diagnoses } : {}),
		bindDeploymentRun: (runId, deploymentRunId) => authorization.bindDeploymentRun(runId, deploymentRunId),
		ids: options.ids,
		bindServerInteraction: options.bindServerInteraction,
		unbindTerminalRun: options.unbindTerminalRun,
		events,
		activity,
		approvals,
		decisions,
		context,
		contextCompactionSettings,
		queues,
		toolCalls,
		runtimeFactory,
		attachments: options.chatAttachments,
		...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
	});
}
