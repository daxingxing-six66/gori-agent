import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	AgentRunError,
	type AgentTool,
	type BashToolInput,
	convertToLlm,
	createBashTool,
	createReadTool,
	createWriteTool,
	type ReadToolInput,
	type WriteToolInput,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type Api, createAssistantMessageEventStream, type Model, type Models } from "@earendil-works/pi-ai";
import { ChatError, type ChatRun } from "../../domain/chat.ts";
import type { ChatCompactionSettings } from "../../domain/context-compaction.ts";
import { type BackendMessageDescriptor, backendMessage } from "../../i18n/message.ts";
import { ChatRunRuntime } from "../chat-run-runtime.ts";
import { runFailure } from "../failure-policy.ts";
import { reportFailure } from "../failure-reporter.ts";
import { type ProviderFailureMessage, providerFailureStream } from "../provider-failure.ts";
import { remoteServerCallDefinition } from "../tools/remote-server-call-tool.ts";
import { terminalInteractionDefinition } from "../tools/terminal-interaction-tool.ts";
import type { RequestSftpDownloadOverwriteApproval } from "../tools/sftp-download-tool.ts";
import type { RequestSftpOverwriteApproval } from "../tools/sftp-upload-tool.ts";
import type { ChatAgentEventHandler } from "./chat-agent-event-handler.ts";
import type { ChatAttachmentService } from "./chat-attachment-service.ts";
import type { ChatContextService } from "./chat-context-service.ts";
import type { ChatQueueService } from "./chat-queue-service.ts";
import type { ChatToolCallCoordinator } from "./chat-tool-call-coordinator.ts";
import { addOpenCodeGoSessionHeaders } from "./opencode-go-session.ts";
import { configureFileToolConcurrency } from "./file-tool-concurrency.ts";

type ToolCallCoordinator = Pick<ChatToolCallCoordinator, "beforeToolCall" | "requestSftpOverwriteApproval">;
type QueueService = Pick<ChatQueueService, "cancelSteeringAfterTurn">;
type AgentEventHandler = Pick<ChatAgentEventHandler, "handle">;

export interface ChatAgentRuntimeFactoryOptions {
	models: Models;
	toolCalls: ToolCallCoordinator;
	queues: QueueService;
	agentEvents: AgentEventHandler;
	context?: ChatContextService;
	attachments: Pick<ChatAttachmentService, "hydrateProviderContext">;
	createRemoteTool(sessionId: string, abortRun?: () => void): AgentTool;
	createTerminalTool(input: { sessionId: string; terminalSessionId: string; agentRunId: string }): AgentTool;
	createSftpTool(input: {
		sessionId: string;
		env: NodeExecutionEnv;
		requestOverwriteApproval: RequestSftpOverwriteApproval;
	}): AgentTool;
	createSftpDownloadTool(input: {
		sessionId: string;
		env: NodeExecutionEnv;
		requestOverwriteApproval: RequestSftpDownloadOverwriteApproval;
	}): AgentTool;
	createExecutionEnv?(workDir: string): NodeExecutionEnv;
	createAgent?(options: AgentOptions): Agent;
}

export class ChatAgentRuntimeFactory {
	readonly #models: Models;
	readonly #toolCalls: ToolCallCoordinator;
	readonly #queues: QueueService;
	readonly #agentEvents: AgentEventHandler;
	readonly #context?: ChatContextService;
	readonly #attachments: ChatAgentRuntimeFactoryOptions["attachments"];
	readonly #createRemoteTool: ChatAgentRuntimeFactoryOptions["createRemoteTool"];
	readonly #createTerminalTool: ChatAgentRuntimeFactoryOptions["createTerminalTool"];
	readonly #createSftpTool: ChatAgentRuntimeFactoryOptions["createSftpTool"];
	readonly #createSftpDownloadTool: ChatAgentRuntimeFactoryOptions["createSftpDownloadTool"];
	readonly #createExecutionEnv: (workDir: string) => NodeExecutionEnv;
	readonly #createAgent: (options: AgentOptions) => Agent;

	constructor(options: ChatAgentRuntimeFactoryOptions) {
		this.#models = options.models;
		this.#toolCalls = options.toolCalls;
		this.#queues = options.queues;
		this.#agentEvents = options.agentEvents;
		this.#context = options.context;
		this.#attachments = options.attachments;
		this.#createRemoteTool = options.createRemoteTool;
		this.#createTerminalTool = options.createTerminalTool;
		this.#createSftpTool = options.createSftpTool;
		this.#createSftpDownloadTool = options.createSftpDownloadTool;
		this.#createExecutionEnv = options.createExecutionEnv ?? ((workDir) => new NodeExecutionEnv({ cwd: workDir }));
		this.#createAgent = options.createAgent ?? ((agentOptions) => new Agent(agentOptions));
	}

	async create(input: {
		systemPrompt: string;
		run: ChatRun;
		model: Model<Api>;
		workDir: string;
		history: AgentMessage[];
		compactionSettings?: ChatCompactionSettings;
	}): Promise<ChatRunRuntime> {
		const env = this.#createExecutionEnv(input.workDir);
		const contextService = this.#context;
		const compactionSettings = input.compactionSettings ?? {
			triggerPercent: 80,
			model: null,
			revision: 1,
			updatedAt: 0,
		};
		let runtime: ChatRunRuntime | undefined;
		try {
			const requireRuntime = (): ChatRunRuntime => {
				if (!runtime) throw new Error("Chat Runtime is unavailable during Agent callback");
				return runtime;
			};
			const read = createReadTool();
			const write = createWriteTool();
			const bash = createBashTool();
			const localTools = [
				{
					...read,
					execute: (id, params, signal, update) =>
						read.execute(id, params as ReadToolInput, signal, update, { env }),
				},
				{
					...write,
					execute: (id, params, signal, update) =>
						write.execute(id, params as WriteToolInput, signal, update, { env }),
				},
				{
					...bash,
					execute: (id, params, signal, update) =>
						bash.execute(id, params as BashToolInput, signal, update, { env }),
				},
			] satisfies AgentTool[];
			const remoteTool =
				input.run.serverInteractionMode === "command"
					? this.#createRemoteTool(input.run.sessionId, () => requireRuntime().abortAgent())
					: unavailableTool(remoteServerCallDefinition);
			const terminalTool =
				input.run.serverInteractionMode === "terminal"
					? this.#createTerminalTool({
							sessionId: input.run.sessionId,
							terminalSessionId: requireTerminalSessionId(input.run),
							agentRunId: input.run.id,
						})
					: unavailableTool(terminalInteractionDefinition);
			const requestSftpOverwriteApproval = async (
				toolName: "sftp_upload" | "sftp_download",
				toolCallId: string,
				description: string,
				descriptionMessage: BackendMessageDescriptor,
				signal: AbortSignal,
			) => {
				try {
					return await this.#toolCalls.requestSftpOverwriteApproval(
						{
							run: input.run,
							toolName,
							toolCallId,
							description,
							descriptionMessage,
							onApprovalRejection: () => requireRuntime().stopAfterApprovalRejection(),
						},
						signal,
					);
				} catch (error) {
					requireRuntime().captureFailure(error);
					throw new AgentRunError(undefined, "Overwrite authorization failed", { cause: error });
				}
			};
			const sftpUploadTool = this.#createSftpTool({
				sessionId: input.run.sessionId,
				env,
				requestOverwriteApproval: (toolCallId, existingEntry, signal) =>
					requestSftpOverwriteApproval(
						"sftp_upload",
						toolCallId,
						`Remote file ${existingEntry.path} already exists. Continuing will overwrite it. Continue?`,
						backendMessage("approval.remote_file_overwrite", { path: existingEntry.path }),
						signal,
					),
			});
			const sftpDownloadTool = this.#createSftpDownloadTool({
				sessionId: input.run.sessionId,
				env,
				requestOverwriteApproval: (toolCallId, existingEntry, signal) =>
					requestSftpOverwriteApproval(
						"sftp_download",
						toolCallId,
						`Local file ${existingEntry.path} already exists. Continuing will overwrite it. Continue?`,
						backendMessage("approval.local_file_overwrite", { path: existingEntry.path }),
						signal,
					),
			});
			let requestAttempt = 0;
			const agent = this.#createAgent({
				onRunFailure: (error) => requireRuntime().captureFailure(error),
				initialState: {
					systemPrompt: input.systemPrompt,
					model: input.model,
					thinkingLevel: input.run.thinkingLevel,
					tools: configureFileToolConcurrency(
						[...localTools, remoteTool, terminalTool, sftpUploadTool, sftpDownloadTool], env,
					),
					messages: input.history,
				},
				streamFn: async (selectedModel, context, options) => {
					let providerContext: typeof context;
					try {
						providerContext = await this.#attachments.hydrateProviderContext(
							input.run.sessionId,
							context,
							selectedModel,
							options?.signal,
						);
					} catch (error) {
						if (options?.signal?.aborted) throw error;
						return attachmentFailureStream(selectedModel, error);
					}
					const headers = addOpenCodeGoSessionHeaders(selectedModel, input.run.sessionId, options?.headers);
					return providerFailureStream(
						selectedModel,
						() =>
							this.#models.streamSimple(
								selectedModel,
								providerContext,
								headers === options?.headers
									? options
									: { ...options, sessionId: input.run.sessionId, headers },
							),
						options?.signal,
						{
							stage: "provider_request",
							runId: input.run.id,
							sessionId: input.run.sessionId,
							requestAttemptId: `${input.run.id}:${++requestAttempt}`,
						},
					);
				},
				convertToLlm,
				...(contextService === undefined
					? {}
					: {
							beforeProviderRequest: async ({ context, model }, signal) => {
								requireRuntime().beginProviderRequest();
								try {
									const outcome = await contextService.compactContext({
										sessionId: input.run.sessionId,
										run: input.run,
										context: contextService.synchronizeRuntimeMode(
											input.run.sessionId, context, input.run.serverInteractionMode,
										),
										sessionModel: model,
										settings: compactionSettings,
										reason: "threshold",
										force: false,
										signal,
									});
									const synchronized = contextService.synchronizeRuntimeMode(
										input.run.sessionId, outcome.context, input.run.serverInteractionMode,
									);
									contextService.recordProviderRequest(input.run.id, model, synchronized);
									return synchronized === context ? undefined : { context: synchronized };
								} catch (error) {
									throw requireRuntime().toAgentError(error);
								}
							},
							recoverProviderError: async ({ context, model, message }, signal) => {
								if (message.errorCode !== "context_overflow") return undefined;
								try {
									const outcome = await contextService.compactContext({
										sessionId: input.run.sessionId,
										run: input.run,
										context: contextService.synchronizeRuntimeMode(
											input.run.sessionId, context, input.run.serverInteractionMode,
										),
										sessionModel: model,
										settings: compactionSettings,
										reason: "overflow",
										force: true,
										signal,
									});
									return { context: contextService.synchronizeRuntimeMode(
										input.run.sessionId, outcome.context, input.run.serverInteractionMode,
									) };
								} catch (error) {
									throw requireRuntime().toAgentError(error, message);
								}
							},
						}),
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				toolExecution: "parallel",
				beforeToolCall: async ({ assistantMessage, toolCall, args }, signal) => {
					try {
						return await this.#toolCalls.beforeToolCall(
							{
								run: input.run,
								assistantMessageId: String(assistantMessage.timestamp),
								toolCallId: toolCall.id,
								toolName: toolCall.name,
								args,
								onApprovalRejection: () => requireRuntime().stopAfterApprovalRejection(),
							},
							signal,
						);
					} catch (error) {
						requireRuntime().captureFailure(error);
						throw new AgentRunError(undefined, "Tool authorization failed", { cause: error });
					}
				},
				shouldContinueAutomaticallyAfterTurn: () => {
					const activeRuntime = requireRuntime();
					if (activeRuntime.consumeContinuationDecision()) return true;
					this.#queues.cancelSteeringAfterTurn(activeRuntime.run, activeRuntime);
					return false;
				},
			});
			runtime = new ChatRunRuntime({
				run: input.run,
				agent,
				env,
				...(contextService ? { loadContextMessages: () => contextService.load(input.run.sessionId) } : {}),
			});
			agent.subscribe((event: AgentEvent) => {
				requireRuntime().annotateFailure(event);
				try {
					this.#agentEvents.handle(input.run, event, {
						onTurnStart: () => requireRuntime().beginTurn(),
						onModelRemoved: () => requireRuntime().markModelRemoved(),
					});
				} catch (error) {
					requireRuntime().captureFailure(
						error,
						event.type === "message_end" ? "message_commit" : "event_projection",
					);
					throw error;
				}
				if (event.type === "turn_end") {
					contextService?.publishUsage(input.run, agent.state.model, requireRuntime().context);
				}
			});
			return runtime;
		} catch (error) {
			try {
				if (runtime) await runtime.dispose();
				else await env.cleanup();
			} catch (cleanupError) {
				reportFailure(cleanupError, { stage: "cleanup", runId: input.run.id });
			}
			throw error;
		}
	}
}

function attachmentFailureStream(model: Model<Api>, error: unknown) {
	const failure =
		error instanceof ChatError
			? error
			: new ChatError("chat_attachment_storage_unavailable", "Chat Attachment storage is unavailable", 500, {
					cause: error,
				});

	const timestamp = Date.now();
	const message: ProviderFailureMessage = {
		failure: runFailure(failure, { stage: "attachment" }),
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		diagnostics: [
			{
				type: "ssh_agent_attachment_input_failure",
				timestamp,
				details: { code: failure.code },
			},
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: failure.message,
		timestamp,
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error: message });
	return stream;
}

function requireTerminalSessionId(run: ChatRun): string {
	if (run.terminalSessionId === null) throw new Error("Terminal-mode Chat Run is missing its TerminalSession binding");
	return run.terminalSessionId;
}

function unavailableTool(definition: Pick<AgentTool, "name" | "description" | "parameters">): AgentTool {
	return {
		...definition,
		label: definition.name,
		execute: async () => {
			throw new Error(`${definition.name} is unavailable in the current server interaction mode`);
		},
	};
}
