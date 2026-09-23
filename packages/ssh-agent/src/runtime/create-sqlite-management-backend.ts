import { join } from "node:path";
import { resolveDataDirectory } from "../data-directory.ts";
import { ChatPromptService } from "../application/services/chat-prompt-service.ts";
import { SqliteChatPromptRepository } from "../infrastructure/sqlite/sqlite-chat-prompt-repository.ts";
import { ConnectionTestService, type SshConnectionTester } from "../application/services/connection-test-service.ts";
import { Ssh2ConnectionTester } from "../infrastructure/ssh/ssh2-connection-tester.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { createSshAgentHttpHandler, type SshAgentHttpHandler } from "../api/http-handler.ts";
import { SshAgentManagementApi } from "../application/management-api.ts";
import { AttachmentService } from "../application/services/attachment-service.ts";
import { ChatAttachmentService } from "../application/services/chat-attachment-service.ts";
import type { ChatService } from "../application/services/chat-service.ts";
import { DefaultCommandGuardEvaluator } from "../application/services/command-guard-evaluator.ts";
import { CommandOperationService } from "../application/services/command-operation-service.ts";
import { ContextCompactionSettingsService } from "../application/services/context-compaction-settings-service.ts";
import { createChatService } from "../application/services/create-chat-service.ts";
import { DefaultCredentialService } from "../application/services/credential-service.ts";
import { PiCustomLlmProviderRuntime } from "../application/services/custom-llm-provider-runtime.ts";
import { DefaultCustomLlmProviderService } from "../application/services/custom-llm-provider-service.ts";
import { FileTransferService } from "../application/services/file-transfer-service.ts";
import { BuiltinGuardRulePackCatalog } from "../application/services/guard-rule-pack-catalog.ts";
import { DefaultGuardService } from "../application/services/guard-service.ts";
import { DefaultLlmModelCatalog, type LlmModelCatalog } from "../application/services/llm-model-catalog.ts";
import { LlmModelRefreshScheduler } from "../application/services/llm-model-refresh-scheduler.ts";
import { DefaultLlmProviderService } from "../application/services/llm-provider-service.ts";
import { DefaultLocalFileSystemService } from "../application/services/local-file-system-service.ts";
import { RemoteMetricsService } from "../application/services/remote-metrics-service.ts";
import { SessionLifecycleCoordinator } from "../application/services/session-lifecycle-coordinator.ts";
import { SessionTitleService } from "../application/services/session-title-service.ts";
import { DefaultSessionService } from "../application/services/session-service.ts";
import { DefaultSshTargetResolver } from "../application/services/ssh-target-resolver.ts";
import { TerminalInteractionService } from "../application/services/terminal-interaction-service.ts";
import { TerminalSessionService } from "../application/services/terminal-session-service.ts";
import { DefaultWorkspaceHostTrustService } from "../application/services/workspace-host-trust-service.ts";
import { DefaultWorkspaceService } from "../application/services/workspace-service.ts";
import { createRemoteServerCallTool } from "../application/tools/remote-server-call-tool.ts";
import { createSftpDownloadTool } from "../application/tools/sftp-download-tool.ts";
import { createSftpUploadTool } from "../application/tools/sftp-upload-tool.ts";
import { createTerminalInteractionTool } from "../application/tools/terminal-interaction-tool.ts";
import { WorkspaceEventHub } from "../application/workspace-event-hub.ts";
import type { Clock, IdGenerator } from "../domain/ids.ts";
import { CredentialCipher } from "../infrastructure/sqlite/credential-cipher.ts";
import { openSshAgentDatabase } from "../infrastructure/sqlite/database.ts";
import { LlmProviderCredentialCipher } from "../infrastructure/sqlite/llm-provider-credential-cipher.ts";
import { SqliteAttachmentRepository } from "../infrastructure/sqlite/sqlite-attachment-repository.ts";
import { SqliteChatRepository } from "../infrastructure/sqlite/sqlite-chat-repository.ts";
import { SqliteCommandOperationRepository } from "../infrastructure/sqlite/sqlite-command-operation-repository.ts";
import { SqliteContextCompactionSettingsRepository } from "../infrastructure/sqlite/sqlite-context-compaction-settings-repository.ts";
import {
	SqliteCredentialRepository,
	SqliteCredentialSecretStore,
} from "../infrastructure/sqlite/sqlite-credential-repository.ts";
import { SqliteCustomLlmProviderRepository } from "../infrastructure/sqlite/sqlite-custom-llm-provider-repository.ts";
import { SqliteFileTransferRepository } from "../infrastructure/sqlite/sqlite-file-transfer-repository.ts";
import { SqliteGuardRepository } from "../infrastructure/sqlite/sqlite-guard-repository.ts";
import { SqliteLlmModelCatalogRepository } from "../infrastructure/sqlite/sqlite-llm-model-catalog-repository.ts";
import { SqliteLlmProviderCredentialStore } from "../infrastructure/sqlite/sqlite-llm-provider-credential-store.ts";
import { SqliteSessionRepository } from "../infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteTerminalRepository } from "../infrastructure/sqlite/sqlite-terminal-repository.ts";
import { SqliteTransactionRunner } from "../infrastructure/sqlite/sqlite-transaction-runner.ts";
import { SqliteWorkspaceHostTrustRepository } from "../infrastructure/sqlite/sqlite-workspace-host-trust-repository.ts";
import { SqliteWorkspaceRepository } from "../infrastructure/sqlite/sqlite-workspace-repository.ts";
import { Ssh2ChannelBroker } from "../infrastructure/ssh/ssh2-channel-broker.ts";
import { Ssh2HostKeyProbe } from "../infrastructure/ssh/ssh2-host-key-probe.ts";

export interface CreateSqliteManagementBackendOptions {
	connectionTester?: SshConnectionTester;
	databasePath: string;
	credentialEncryptionKey: Uint8Array;
	clock?: Clock;
	ids?: IdGenerator;
	llmModelsFactory: LlmModelsFactory;
	localCwd?: string;
	maxConcurrentOperations?: number;
	chatApprovalTimeoutMs?: number;
	attachmentBaseDir?: string;
	llmCatalogBaseUrl?: string;
	llmCatalogFetch?: typeof fetch;
	llmCatalogRefreshIntervalMs?: number;
}

export type LlmModelsFactory = (credentials: CredentialStore) => MutableModels;

export interface SqliteManagementBackend {
	api: SshAgentManagementApi;
	handleRequest: SshAgentHttpHandler;
	database: DatabaseSync;
	llmModels: MutableModels;
	llmModelCatalog: LlmModelCatalog;
	commandOperations: CommandOperationService;
	fileTransfers: FileTransferService;
	attachments: AttachmentService;
	terminalSessions: TerminalSessionService;
	terminalInteractions: TerminalInteractionService;
	refreshLlmModels(): Promise<void>;
	createRemoteServerCallTool(sessionId: string, abortRun?: () => void): ReturnType<typeof createRemoteServerCallTool>;
	close(): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now() };
const uuidGenerator: IdGenerator = { next: () => randomUUID() };

export function createSqliteManagementBackend(options: CreateSqliteManagementBackendOptions): SqliteManagementBackend {
	const database = openSshAgentDatabase(options.databasePath);
	try {
		const sshCredentials = new SqliteCredentialRepository(database);
		const workspaces = new SqliteWorkspaceRepository(database);
		const hostTrusts = new SqliteWorkspaceHostTrustRepository(database);
		const sessions = new SqliteSessionRepository(database);
		const attachmentRepository = new SqliteAttachmentRepository(database);
		const guards = new SqliteGuardRepository(database);
		const transactions = new SqliteTransactionRunner(database);
		const commandOperationRepository = new SqliteCommandOperationRepository(database);
		const fileTransferRepository = new SqliteFileTransferRepository(database);
		const chatRepository = new SqliteChatRepository(database);
		const contextCompactionSettingsRepository = new SqliteContextCompactionSettingsRepository(database);
		const clock = options.clock ?? systemClock;
		const ids = options.ids ?? uuidGenerator;
		chatRepository.recoverInterrupted(clock.now());
		const terminalRepository = new SqliteTerminalRepository(database);
		terminalRepository.recoverInterrupted(clock.now());
		const sessionLifecycle = new SessionLifecycleCoordinator();
		const attachments = new AttachmentService({
			attachments: attachmentRepository,
			sessions,
			clock,
			ids,
			lifecycle: sessionLifecycle,
			...(options.attachmentBaseDir === undefined ? {} : { attachmentBaseDir: options.attachmentBaseDir }),
		});
		const chatAttachments = new ChatAttachmentService({
			attachments: attachmentRepository,
			...(options.attachmentBaseDir === undefined ? {} : { attachmentBaseDir: options.attachmentBaseDir }),
		});
		const rulePacks = new BuiltinGuardRulePackCatalog();
		const secrets = new SqliteCredentialSecretStore(database, new CredentialCipher(options.credentialEncryptionKey));
		const connectionPool = new Ssh2ChannelBroker(secrets);
		const hostTrust = new DefaultWorkspaceHostTrustService({
			hostTrusts,
			probe: new Ssh2HostKeyProbe(),
			clock,
		});
		const targets = new DefaultSshTargetResolver({ sessions, workspaces, credentials: sshCredentials, hostTrust });
		const events = new WorkspaceEventHub();
		const fileTransfers = new FileTransferService({
			transfers: fileTransferRepository,
			targets,
			broker: connectionPool,
			events,
			clock,
			ids,
		});
		const metrics = new RemoteMetricsService({ targets, broker: connectionPool, events });
		const heartbeat = setInterval(() => events.heartbeat(), 15_000);
		heartbeat.unref();
		const commandGuard = new DefaultCommandGuardEvaluator(guards);
		const commandOperations = new CommandOperationService({
			operations: commandOperationRepository,
			sessions,
			targets,
			guards: commandGuard,
			broker: connectionPool,
			clock,
			ids,
			lifecycle: sessionLifecycle,
			...(options.maxConcurrentOperations === undefined
				? {}
				: { maxConcurrentOperations: options.maxConcurrentOperations }),
		});
		const llmCredentials = new SqliteLlmProviderCredentialStore({
			database,
			cipher: new LlmProviderCredentialCipher(options.credentialEncryptionKey),
			transactions,
			clock,
		});
		const llmModels = options.llmModelsFactory(llmCredentials);
		const customLlmProviderRepository = new SqliteCustomLlmProviderRepository(database);
		const customLlmProviders = new DefaultCustomLlmProviderService({
			repository: customLlmProviderRepository,
			runtime: new PiCustomLlmProviderRuntime(llmModels),
			models: llmModels,
			clock,
			credentials: llmCredentials,
			transactions,
			hasActiveRun: (providerId) => chatRepository.hasActiveProvider(providerId),
		});
		customLlmProviders.restore();
		const llmModelCatalog = new DefaultLlmModelCatalog({
			models: llmModels,
			repository: new SqliteLlmModelCatalogRepository(database),
			clock,
			...(options.llmCatalogBaseUrl === undefined ? {} : { baseUrl: options.llmCatalogBaseUrl }),
			...(options.llmCatalogFetch === undefined ? {} : { fetch: options.llmCatalogFetch }),
		});
		const contextCompactionSettings = new ContextCompactionSettingsService({
			repository: contextCompactionSettingsRepository,
			catalog: llmModelCatalog,
			clock,
		});
		const llmModelRefresh = new LlmModelRefreshScheduler({
			catalog: llmModelCatalog,
			credentials: llmCredentials,
			shouldRefreshProvider: (providerId) => customLlmProviders.find(providerId) === undefined,
			...(options.llmCatalogRefreshIntervalMs === undefined
				? {}
				: { intervalMs: options.llmCatalogRefreshIntervalMs }),
		});
		let chat: ChatService | undefined;
		const terminalSessions = new TerminalSessionService({
			sessions,
			terminals: terminalRepository,
			targets,
			broker: connectionPool.terminals,
			lifecycle: sessionLifecycle,
			clock,
			ids,
			hasActiveChatRun: (sessionId) => chat?.hasActiveRun(sessionId) ?? Promise.resolve(false),
		});
		const terminalInteractions = new TerminalInteractionService({
			repository: terminalRepository,
			sessions,
			terminals: terminalSessions,
			guards: commandGuard,
			clock,
			ids,
		});
		chat = createChatService({
			prompts: new ChatPromptService(new SqliteChatPromptRepository(database), workspaces),
			titles: new SessionTitleService({ models: llmModels, sessions, events }),
			chatRepository,
			chatAttachments,
			sessions,
			models: llmModels,
			catalog: llmModelCatalog,
			contextCompactionSettings,
			localCwd: options.localCwd ?? join(resolveDataDirectory(), "workspace"),
			ids,
			lifecycle: sessionLifecycle,
			...(options.chatApprovalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.chatApprovalTimeoutMs }),
			createRemoteTool: (sessionId, abortRun) =>
				createRemoteServerCallTool({
					sessionId,
					operations: commandOperations,
					...(abortRun === undefined ? {} : { abortRun }),
				}),
			createTerminalTool: ({ sessionId, terminalSessionId, agentRunId }) =>
				createTerminalInteractionTool({
					sessionId,
					terminalSessionId,
					agentRunId,
					interactions: terminalInteractions,
				}),
			bindServerInteraction: (sessionId, runId, mode) => terminalSessions.bindRun(sessionId, runId, mode),
			unbindTerminalRun: (sessionId, runId) => terminalSessions.unbindRun(sessionId, runId),
			terminalInteractions,
			createSftpTool: ({ sessionId, env, requestOverwriteApproval }) =>
				createSftpUploadTool({
					sessionId,
					env,
					targets,
					broker: connectionPool,
					requestOverwriteApproval,
				}),
			createSftpDownloadTool: ({ sessionId, env, requestOverwriteApproval }) =>
				createSftpDownloadTool({
					sessionId,
					env,
					targets,
					broker: connectionPool,
					requestOverwriteApproval,
				}),
			preflightRemoteGuard: async (sessionId, command) => {
				const decision = await commandOperations.preflightGuard(sessionId, command);
				return {
					allowed: decision.allowed,
					...(decision.matchedRule?.reason === undefined ? {} : { reason: decision.matchedRule.reason }),
				};
			},
		});
		const localFiles = new DefaultLocalFileSystemService({
			sessions,
			localCwd: options.localCwd ?? join(resolveDataDirectory(), "workspace"),
		});
		const credentialService = new DefaultCredentialService({
			credentials: sshCredentials,
			secrets,
			workspaces,
			transactions,
			clock,
			ids,
			connections: connectionPool,
		});
		const api = new SshAgentManagementApi({
			credentials: credentialService,
			workspaces: new DefaultWorkspaceService({
				workspaces,
				credentials: sshCredentials,
				secrets,
				sessions,
				guards,
				transactions,
				clock,
				ids,
				connections: connectionPool,
			}),
			sessions: new DefaultSessionService({
				sessions,
				workspaces,
				clock,
				ids,
				lifecycle: sessionLifecycle,
				operations: commandOperationRepository,
				hasActiveChatRun: (sessionId) => chat.hasActiveRun(sessionId),
				closeTerminalForDeletion: (sessionId) => terminalSessions.closeForSessionDeletion(sessionId),
				cleanupAttachmentsForDeletion: (sessionId) => attachments.cleanupSession(sessionId),
			}),
			guards: new DefaultGuardService({ guards, clock, ids, rulePacks }),
			llmProviders: new DefaultLlmProviderService({
				models: llmModels,
				catalog: llmModelCatalog,
				credentials: llmCredentials,
				clock,
				transactions,
				customProviders: customLlmProviders,
			}),
			customLlmProviders,
			contextCompactionSettings,
		});
		const connectionTests = new ConnectionTestService(options.connectionTester ?? new Ssh2ConnectionTester());
		return {
			api,
			handleRequest: createSshAgentHttpHandler({
				connectionTests,
				api,
				transfers: fileTransfers,
				events,
				broker: connectionPool,
				chat,
				localFiles,
				terminals: terminalSessions,
				attachments,
			}),
			database,
			llmModels,
			llmModelCatalog,
			commandOperations,
			fileTransfers,
			attachments,
			terminalSessions,
			terminalInteractions,
			refreshLlmModels: () => llmModelRefresh.refreshConfigured(),
			createRemoteServerCallTool: (sessionId, abortRun) =>
				createRemoteServerCallTool({
					sessionId,
					operations: commandOperations,
					...(abortRun === undefined ? {} : { abortRun }),
				}),
			close: async () => {
				connectionTests.close();
				clearInterval(heartbeat);
				llmModelRefresh.close();
				await chat.close();
				metrics.close();
				events.close();
				commandOperations.close();
				await terminalSessions.shutdown();
				connectionPool.close();
				database.close();
			},
		};
	} catch (error) {
		database.close();
		throw error;
	}
}
