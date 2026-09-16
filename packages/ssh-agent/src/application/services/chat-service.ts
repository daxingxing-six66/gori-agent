import { stat } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type {
	ChatMessageListCursor,
	ChatMessagePage,
	ChatModelSelection,
	ChatQueueBehavior,
	ChatQueueItem,
	ChatQueueItemStatus,
	ChatRun,
	ToolApproval,
} from "../../domain/chat.ts";
import { ChatError } from "../../domain/chat.ts";
import { type ChatUserMessage, createChatUserMessage } from "../../domain/chat-attachment.ts";
import type { ChatContextUsage } from "../../domain/chat-context-usage.ts";
import type { ManualChatCompactionResult } from "../../domain/context-compaction.ts";
import type { IdGenerator } from "../../domain/ids.ts";
import type { BackendLocale } from "../../i18n/message.ts";
import { createChatContext } from "../chat-context.ts";
import type { ChatRunEventHub } from "../chat-run-event-hub.ts";
import type { ChatRunRuntime } from "../chat-run-runtime.ts";
import { runFailure } from "../failure-policy.ts";
import { reportFailure } from "../failure-reporter.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { ChatAgentRuntimeFactory } from "./chat-agent-runtime-factory.ts";
import type { ChatApprovalService } from "./chat-approval-service.ts";
import type { ChatAttachmentService } from "./chat-attachment-service.ts";
import type { ChatContextService } from "./chat-context-service.ts";
import type { ChatQueueService } from "./chat-queue-service.ts";
import { executeChatRun, PendingRunCommits } from "./chat-run-executor.ts";
import type { ChatToolCallCoordinator } from "./chat-tool-call-coordinator.ts";
import type { ContextCompactionSettingsService } from "./context-compaction-settings-service.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";
import type { SessionLifecycleCoordinator, SessionUseLease } from "./session-lifecycle-coordinator.ts";

type ActiveRun = {
	runtime: ChatRunRuntime;
	sessionLease?: SessionUseLease;
};
type ContextCompactionSettingsReader = Pick<ContextCompactionSettingsService, "get">;

export interface ChatServiceDependencies {
	chatRepository: ChatRepository;
	sessions: SessionRepository;
	models: Models;
	catalog: LlmModelCatalog;
	localCwd: string;
	ids: IdGenerator;
	bindServerInteraction(sessionId: string, runId: string, mode: "command" | "terminal"): Promise<string | null>;
	unbindTerminalRun(sessionId: string, runId: string): Promise<void>;
	events: ChatRunEventHub;
	approvals: ChatApprovalService;
	context: ChatContextService;
	contextCompactionSettings: ContextCompactionSettingsReader;
	queues: ChatQueueService;
	toolCalls: ChatToolCallCoordinator;
	runtimeFactory: Pick<ChatAgentRuntimeFactory, "create">;
	attachments: Pick<ChatAttachmentService, "requireImageModelForContext" | "validateReferences">;
	lifecycle?: SessionLifecycleCoordinator;
}

export class ChatService {
	private readonly chatRepository: ChatRepository;
	private readonly sessions: SessionRepository;
	private readonly models: Models;
	private readonly catalog: LlmModelCatalog;
	private readonly localCwd: string;
	private readonly ids: IdGenerator;
	private readonly bindServerInteraction: ChatServiceDependencies["bindServerInteraction"];
	private readonly unbindTerminalRun: ChatServiceDependencies["unbindTerminalRun"];
	private readonly lifecycle?: SessionLifecycleCoordinator;
	private readonly pendingCommits = new PendingRunCommits();
	private readonly runningTasks = new Set<Promise<void>>();
	private closing = false;
	private readonly active = new Map<string, ActiveRun>();
	private readonly events: ChatRunEventHub;
	private readonly approvals: ChatApprovalService;
	private readonly context: ChatContextService;
	private readonly contextCompactionSettings: ContextCompactionSettingsReader;
	private readonly manualCompactions = new Set<string>();
	private readonly queues: ChatQueueService;
	private readonly toolCalls: ChatToolCallCoordinator;
	private readonly runtimeFactory: Pick<ChatAgentRuntimeFactory, "create">;
	private readonly attachments: ChatServiceDependencies["attachments"];

	constructor(options: ChatServiceDependencies) {
		this.chatRepository = options.chatRepository;
		this.sessions = options.sessions;
		this.models = options.models;
		this.catalog = options.catalog;
		this.localCwd = options.localCwd;
		this.ids = options.ids;
		this.bindServerInteraction = options.bindServerInteraction;
		this.unbindTerminalRun = options.unbindTerminalRun;
		this.events = options.events;
		this.approvals = options.approvals;
		this.context = options.context;
		this.contextCompactionSettings = options.contextCompactionSettings;
		this.queues = options.queues;
		this.toolCalls = options.toolCalls;
		this.runtimeFactory = options.runtimeFactory;
		this.attachments = options.attachments;
		this.lifecycle = options.lifecycle;
	}

	hasActiveRun(sessionId: string): Promise<boolean> {
		this.pendingCommits.reconcile(sessionId);
		return Promise.resolve(this.active.has(sessionId));
	}

	async getActiveRun(sessionId: string): Promise<ChatRun | null> {
		this.pendingCommits.reconcile(sessionId);
		if (!(await this.sessions.findById(sessionId)))
			throw new ChatError("chat_session_not_found", "Session not found", 404);
		const runtime = this.active.get(sessionId);
		return runtime ? { ...runtime.runtime.run } : null;
	}

	getLatestModelSelection(sessionId: string): ChatModelSelection | null {
		return this.chatRepository.findLatestModelSelection(sessionId) ?? null;
	}

	async getContextUsage(sessionId: string): Promise<ChatContextUsage | null> {
		if (!(await this.sessions.findById(sessionId)))
			throw new ChatError("chat_session_not_found", "Session not found", 404);
		const runtime = this.active.get(sessionId)?.runtime;
		if (runtime) return this.context.usage(runtime.model, runtime.context);
		const run = this.chatRepository.findLatestRun(sessionId);
		if (!run) return null;
		const model = this.catalog.getModel(run.providerId, run.modelId);
		return model ? this.context.usage(model, createChatContext(run, this.context.load(sessionId))) : null;
	}

	async createRun(input: {
		sessionId: string;
		requestId: string;
		providerId?: string;
		modelId?: string;
		thinkingLevel?: ThinkingLevel;
		message: string;
		attachmentIds?: string[];
		serverInteractionMode: "command" | "terminal";
	}): Promise<ChatRun> {
		if (this.closing) throw new ChatError("chat_session_busy", "Chat service is closing", 503);
		this.pendingCommits.reconcile(input.sessionId);
		const existing = this.chatRepository.findRunByRequest(input.sessionId, input.requestId);
		if (existing) return existing;
		if (this.active.has(input.sessionId) || this.manualCompactions.has(input.sessionId))
			throw new ChatError("chat_session_busy", "Session already has an active Chat Run", 409);
		const session = await this.sessions.findById(input.sessionId);
		if (!session) throw new ChatError("chat_session_not_found", "Session not found", 404);
		const sessionLease = this.lifecycle?.acquireUse(session.id, "chat_run");
		let leaseTransferred = false;
		let terminalBinding: { readonly runId: string; readonly terminalSessionId: string } | undefined;
		try {
			const workDir = session.workDir ?? this.localCwd;
			try {
				if (!(await stat(workDir)).isDirectory()) throw new Error("not a directory");
			} catch (error) {
				throw new ChatError("session_work_dir_unavailable", "Session local working directory is unavailable", 409, {
					cause: error,
				});
			}
			const selection = this.resolveModelSelection(input);
			const model = this.catalog.getModel(selection.providerId, selection.modelId);
			if (!model) throw new ChatError("chat_model_not_found", "The selected model is unavailable", 404);
			if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel))
				throw new ChatError(
					"chat_thinking_level_unsupported",
					`The selected model does not support thinking level: ${selection.thinkingLevel}`,
				);
			if ((await this.models.checkAuth(selection.providerId)) === undefined)
				throw new ChatError("chat_provider_not_configured", "LLM Provider is not configured", 409);
			const message = input.message.trim();
			const attachmentIds = input.attachmentIds ?? [];
			if (!message && attachmentIds.length === 0)
				throw new ChatError("chat_message_invalid", "message must not be empty");
			await this.attachments.validateReferences(session.id, attachmentIds, model);
			const history = this.context.load(session.id);
			this.attachments.requireImageModelForContext(model, history);
			const now = Date.now();
			const userMessage = createChatUserMessage(message, attachmentIds, now);
			const runId = this.ids.next();
			const terminalSessionId = await this.bindServerInteraction(session.id, runId, input.serverInteractionMode);
			if (terminalSessionId !== null) terminalBinding = { runId, terminalSessionId };
			const run: ChatRun = {
				id: runId,
				sessionId: session.id,
				workspaceId: session.workspaceId,
				requestId: input.requestId,
				providerId: selection.providerId,
				modelId: selection.modelId,
				thinkingLevel: selection.thinkingLevel,
				serverInteractionMode: input.serverInteractionMode,
				terminalSessionId,
				status: "pending",
				createdAt: now,
				updatedAt: now,
			};
			this.chatRepository.insertRun(run);
			let runtime: ChatRunRuntime;
			try {
				runtime = await this.runtimeFactory.create({
					run,
					model,
					workDir,
					history,
					compactionSettings: this.contextCompactionSettings.get(),
				});
			} catch (error) {
				this.updateRun(run, "failed", runFailure(error, { stage: "runtime_setup", runId, sessionId: session.id }));
				throw error;
			}
			const activeRun: ActiveRun = {
				runtime,
				...(sessionLease === undefined ? {} : { sessionLease }),
			};
			this.active.set(session.id, activeRun);
			leaseTransferred = true;
			terminalBinding = undefined;
			const task = this.executeRun(activeRun, userMessage).catch((error) => {
				reportFailure(error, { stage: "run_commit", runId, sessionId: session.id });
			});
			this.runningTasks.add(task);
			void task.finally(() => this.runningTasks.delete(task));
			return run;
		} finally {
			try {
				if (terminalBinding) {
					try {
						await this.unbindTerminalRun(session.id, terminalBinding.runId);
					} catch (error) {
						reportFailure(error, { stage: "cleanup", runId: terminalBinding.runId, sessionId: session.id });
					}
				}
			} finally {
				if (!leaseTransferred) sessionLease?.release();
			}
		}
	}

	async compactSession(sessionId: string, signal?: AbortSignal): Promise<ManualChatCompactionResult> {
		if (this.closing) throw new ChatError("chat_session_busy", "Chat service is closing", 503);
		this.pendingCommits.reconcile(sessionId);
		if (this.active.has(sessionId) || this.manualCompactions.has(sessionId)) {
			throw new ChatError("chat_session_busy", "Session already has an active Chat operation", 409);
		}
		this.manualCompactions.add(sessionId);
		let lease: SessionUseLease | undefined;
		try {
			const session = await this.sessions.findById(sessionId);
			if (!session) throw new ChatError("chat_session_not_found", "Session not found", 404);
			lease = this.lifecycle?.acquireUse(sessionId, "chat_compaction");
			const messages = this.context.load(sessionId);
			if (messages.length === 0)
				return {
					status: "skipped",
					reason: "nothing_to_compact",
					attempts: 0,
					contextUsage: await this.getContextUsage(sessionId),
				};
			const selection = this.chatRepository.findLatestRun(sessionId);
			if (!selection) {
				throw new ChatError("chat_compaction_model_unavailable", "Session has no model selection", 409);
			}
			const model = this.catalog.getModel(selection.providerId, selection.modelId);
			if (!model) throw new ChatError("chat_compaction_model_unavailable", "Session model is unavailable", 409);
			const outcome = await this.context.compactContext({
				sessionId,
				run: null,
				context: createChatContext(selection, messages),
				sessionModel: model,
				settings: this.contextCompactionSettings.get(),
				reason: "manual",
				force: true,
				signal,
			});
			if (outcome.status === "nothing_to_compact" || !outcome.message || !outcome.model) {
				return {
					status: "skipped",
					reason: "nothing_to_compact",
					attempts: 0,
					contextUsage: this.context.usage(model, outcome.context),
				};
			}
			return {
				status: "completed",
				reason: "manual",
				contextUsage: this.context.usage(model, outcome.context),
				attempts: outcome.attempts as 1 | 2,
				message: outcome.message,
				tokensBefore: outcome.tokensBefore,
				estimatedTokensAfter: outcome.estimatedTokensAfter,
				reductionPercent: outcome.reductionPercent,
				model: outcome.model,
			};
		} finally {
			lease?.release();
			this.manualCompactions.delete(sessionId);
		}
	}

	async enqueue(
		sessionId: string,
		runId: string,
		input: { requestId: string; behavior: ChatQueueBehavior; message: string; attachmentIds?: string[] },
	): Promise<{ id: string; status: ChatQueueItemStatus }> {
		const runtime = this.requireRuntime(sessionId, runId);
		try {
			return await this.queues.enqueue(runtime.run, runtime, runtime.acceptsSteering, runtime.model, input);
		} catch (error) {
			if (error instanceof ChatError && error.code === "chat_persistence_failed") {
				runtime.captureFailure(error);
				runtime.abortAgent();
			}
			throw error;
		}
	}

	promoteQueued(sessionId: string, runId: string, itemId: string): ChatQueueItem {
		const runtime = this.requireRuntime(sessionId, runId);
		if (
			runtime.cancellationRequested ||
			!runtime.acceptsSteering ||
			!["pending", "running"].includes(runtime.run.status)
		) {
			throw new ChatError("chat_run_not_active", "Chat Run does not currently accept steering", 409);
		}
		try {
			return this.queues.promote(runtime.run, runtime, itemId);
		} catch (error) {
			if (error instanceof ChatError && error.code === "chat_persistence_failed") {
				runtime.captureFailure(error);
				runtime.abortAgent();
			}
			throw error;
		}
	}

	cancelQueued(sessionId: string, runId: string, itemId: string): void {
		const runtime = this.requireRuntime(sessionId, runId);
		this.queues.cancel(runtime.run, runtime, itemId);
	}

	async cancelRun(sessionId: string, runId: string): Promise<ChatRun> {
		const run = this.chatRepository.findRun(runId, sessionId);
		if (!run) throw new ChatError("chat_run_not_found", "Chat Run not found", 404);
		const activeRun = this.active.get(sessionId);
		if (activeRun?.runtime.run.id === runId) {
			activeRun.runtime.requestCancellation();
			try {
				this.approvals.cancelRun(runId, "run_cancelled");
				this.queues.cancelRun(activeRun.runtime.run);
			} catch (error) {
				activeRun.runtime.captureFailure(error);
				throw error;
			} finally {
				activeRun.runtime.abortAgent();
			}
		}
		return this.chatRepository.findRun(runId, sessionId) ?? run;
	}

	listMessages(sessionId: string, cursor: ChatMessageListCursor, limit: number): ChatMessagePage {
		if (cursor.direction === "after") {
			const results = this.chatRepository.listMessages(sessionId, cursor.sequence, limit + 1);
			const messages = results.slice(0, limit);
			return {
				messages,
				nextBeforeSequence: null,
				nextSequence: results.length > limit ? (messages.at(-1)?.sequence ?? null) : null,
			};
		}

		const results = this.chatRepository.listMessagesBefore(
			sessionId,
			cursor.direction === "before" ? cursor.sequence : undefined,
			limit + 1,
		);
		const messages = results.length > limit ? results.slice(1) : results;
		return {
			messages,
			nextBeforeSequence: results.length > limit ? (messages[0]?.sequence ?? null) : null,
			nextSequence: null,
		};
	}

	listQueue(sessionId: string, runId: string, status: ChatQueueItemStatus = "pending"): ChatQueueItem[] {
		const run = this.chatRepository.findRun(runId, sessionId);
		if (!run) throw new ChatError("chat_run_not_found", "Chat Run not found", 404);
		return this.queues.list(run, status);
	}

	listApprovals(sessionId: string, status = "pending"): ToolApproval[] {
		return this.approvals.list(sessionId, status);
	}

	resolveApproval(sessionId: string, approvalId: string, approved: boolean): ToolApproval {
		return this.approvals.resolve(sessionId, approvalId, approved);
	}

	subscribe(
		sessionId: string,
		runId: string,
		lastEventId?: number,
		locale?: BackendLocale,
	): ReadableStream<Uint8Array> {
		if (!this.chatRepository.findRun(runId, sessionId))
			throw new ChatError("chat_run_not_found", "Chat Run not found", 404);
		return this.events.subscribe(runId, lastEventId, locale);
	}

	async close(): Promise<void> {
		this.closing = true;
		for (const activeRun of this.active.values()) {
			activeRun.runtime.requestCancellation();
			activeRun.runtime.abortAgent();
		}
		this.approvals.close();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled([...this.runningTasks]),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Chat shutdown did not settle within 10 seconds")), 10_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		this.toolCalls.close();
		this.events.close();
	}

	private executeRun(activeRun: ActiveRun, message: ChatUserMessage): Promise<void> {
		const { runtime } = activeRun;
		return executeChatRun({
			runtime,
			message,
			update: (status, failure) => this.updateRun(runtime.run, status, failure),
			cleanup: [
				() => this.approvals.cancelRun(runtime.run.id, "run_cancelled"),
				() => this.queues.cancelRun(runtime.run),
				() => this.toolCalls.clearRun(runtime.run.id),
				() => this.finalizeRun(activeRun),
			],
		});
	}

	private async finalizeRun(activeRun: ActiveRun): Promise<void> {
		const { runtime } = activeRun;
		try {
			await runtime.dispose();
		} catch (error) {
			reportFailure(error, { stage: "cleanup", runId: runtime.run.id });
		} finally {
			try {
				if (runtime.run.terminalSessionId !== null) {
					try {
						await this.unbindTerminalRun(runtime.run.sessionId, runtime.run.id);
					} catch (error) {
						reportFailure(error, { stage: "cleanup", runId: runtime.run.id });
					}
				}
			} finally {
				try {
					if (this.active.get(runtime.run.sessionId) === activeRun) {
						this.active.delete(runtime.run.sessionId);
					}
				} finally {
					activeRun.sessionLease?.release();
				}
			}
		}
	}

	private resolveModelSelection(input: {
		sessionId: string;
		providerId?: string;
		modelId?: string;
		thinkingLevel?: ThinkingLevel;
	}): ChatModelSelection {
		if ((input.providerId === undefined) !== (input.modelId === undefined))
			throw new ChatError("chat_model_selection_invalid", "providerId and modelId must be provided together");
		const previous = this.chatRepository.findLatestModelSelection(input.sessionId);
		if (input.providerId === undefined || input.modelId === undefined) {
			if (!previous)
				throw new ChatError(
					"chat_model_selection_required",
					"A model selection is required for the first Chat Run",
				);
			return {
				providerId: previous.providerId,
				modelId: previous.modelId,
				thinkingLevel: input.thinkingLevel ?? previous.thinkingLevel,
			};
		}
		const modelUnchanged = previous?.providerId === input.providerId && previous.modelId === input.modelId;
		return {
			providerId: input.providerId,
			modelId: input.modelId,
			thinkingLevel: input.thinkingLevel ?? (modelUnchanged ? previous.thinkingLevel : "off"),
		};
	}

	private updateRun(run: ChatRun, status: ChatRun["status"], failure?: ChatRun["failure"]): void {
		const target = run;
		run = { ...run };
		const now = Date.now();
		run.status = status;
		run.updatedAt = now;
		if (status === "running") run.startedAt = now;
		if (status === "completed" || status === "failed" || status === "cancelled") run.finishedAt = now;
		if (failure) run.failure = failure;
		const commit = () => {
			this.chatRepository.updateRun(run);
			Object.assign(target, run);
			this.events.publish(run.id, "run.updated", run);
		};
		try {
			commit();
		} catch (error) {
			if (status === "running" || status === "pending") throw error;
			const failure = this.pendingCommits.retain(run, error, commit);
			this.events.publish(run.id, "run.persistence_failed", {
				runId: run.id,
				failure: runFailure(failure, { stage: "run_commit", runId: run.id, sessionId: run.sessionId }),
			});
			throw failure;
		}
	}

	private requireRuntime(sessionId: string, runId: string): ChatRunRuntime {
		const runtime = this.active.get(sessionId)?.runtime;
		if (!runtime || runtime.run.id !== runId)
			throw new ChatError("chat_run_not_active", "Chat Run is not active", 409);
		return runtime;
	}
}
