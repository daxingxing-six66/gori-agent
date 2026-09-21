import type {
	LlmProviderCredentialsResponse,
	LlmProvidersResponse,
	WorkspaceCredential,
	WorkspaceCredentials,
	WorkspaceSessionTree,
} from "../api/contracts.ts";
import type { ChatCompactionSettings, UpdateChatCompactionSettingsInput } from "../domain/context-compaction.ts";
import type { CreateCredentialInput, Credential } from "../domain/credential.ts";
import type { Guard, UpdateGuardInput } from "../domain/guard.ts";
import type {
	GuardRulePacksResponse,
	ImportGuardRulePacksInput,
	ImportGuardRulePacksResponse,
} from "../domain/guard-rule-pack.ts";
import type { CredentialId, SessionId, WorkspaceId } from "../domain/ids.ts";
import type {
	ConfigureLlmProviderApiKeyInput,
	CreateCustomLlmProviderInput,
	CustomLlmProvider,
	DeleteCustomLlmProviderInput,
	DeleteLlmProviderCredentialInput,
	LlmProviderCredential,
	LlmProviderModels,
	UpdateCustomLlmProviderInput,
} from "../domain/llm-provider.ts";
import type { CreateSessionInput, DeleteSessionInput, Session, UpdateSessionInput } from "../domain/session.ts";
import type {
	ActivateWorkspaceCredentialInput,
	ActiveWorkspaceCredential,
	CreateWorkspaceInput,
	CreateWorkspaceResult,
	DeleteWorkspaceInput,
	UpdateWorkspaceInput,
	Workspace,
} from "../domain/workspace.ts";
import type { ContextCompactionSettingsService } from "./services/context-compaction-settings-service.ts";
import type { CredentialService, DeleteCredentialInput } from "./services/credential-service.ts";
import type { CustomLlmProviderService } from "./services/custom-llm-provider-service.ts";
import type { GuardService } from "./services/guard-service.ts";
import type { LlmProviderService } from "./services/llm-provider-service.ts";
import type { SessionService } from "./services/session-service.ts";
import type { WorkspaceService } from "./services/workspace-service.ts";

export interface SshAgentManagementApiOptions {
	credentials: CredentialService;
	workspaces: WorkspaceService;
	sessions: SessionService;
	guards: GuardService;
	llmProviders: LlmProviderService;
	customLlmProviders: CustomLlmProviderService;
	contextCompactionSettings: ContextCompactionSettingsService;
}

export class SshAgentManagementApi {
	private readonly credentials: CredentialService;
	private readonly workspaces: WorkspaceService;
	private readonly sessions: SessionService;
	private readonly guards: GuardService;
	private readonly llmProviders: LlmProviderService;
	private readonly customLlmProviders: CustomLlmProviderService;
	private readonly contextCompactionSettings: ContextCompactionSettingsService;

	constructor(options: SshAgentManagementApiOptions) {
		this.credentials = options.credentials;
		this.workspaces = options.workspaces;
		this.sessions = options.sessions;
		this.guards = options.guards;
		this.llmProviders = options.llmProviders;
		this.customLlmProviders = options.customLlmProviders;
		this.contextCompactionSettings = options.contextCompactionSettings;
	}

	getContextCompactionSettings(): ChatCompactionSettings {
		return this.contextCompactionSettings.get();
	}

	updateContextCompactionSettings(input: UpdateChatCompactionSettingsInput): ChatCompactionSettings {
		return this.contextCompactionSettings.update(input);
	}

	async listLlmProviders(): Promise<LlmProvidersResponse> {
		return { providers: await this.llmProviders.listProviders() };
	}

	listLlmProviderModels(providerId: string): Promise<LlmProviderModels> {
		return this.llmProviders.listModels(providerId);
	}

	async listLlmProviderCredentials(): Promise<LlmProviderCredentialsResponse> {
		return { credentials: await this.llmProviders.listCredentials() };
	}

	getLlmProviderCredential(providerId: string): Promise<LlmProviderCredential> {
		return this.llmProviders.getCredential(providerId);
	}

	configureLlmProviderApiKey(input: ConfigureLlmProviderApiKeyInput): Promise<LlmProviderCredential> {
		return this.llmProviders.configureApiKey(input);
	}

	deleteLlmProviderCredential(input: DeleteLlmProviderCredentialInput): Promise<void> {
		return this.llmProviders.deleteCredential(input);
	}

	listCustomLlmProviders(): Promise<readonly CustomLlmProvider[]> {
		return this.customLlmProviders.list();
	}

	getCustomLlmProvider(providerId: string): Promise<CustomLlmProvider> {
		return this.customLlmProviders.get(providerId);
	}

	createCustomLlmProvider(input: CreateCustomLlmProviderInput): Promise<CustomLlmProvider> {
		return this.customLlmProviders.create(input);
	}

	updateCustomLlmProvider(input: UpdateCustomLlmProviderInput): Promise<CustomLlmProvider> {
		return this.customLlmProviders.update(input);
	}

	deleteCustomLlmProvider(input: DeleteCustomLlmProviderInput): Promise<void> {
		return this.customLlmProviders.delete(input);
	}

	async getWorkspaceSessionTree(): Promise<WorkspaceSessionTree> {
		const [workspaces, sessions] = await Promise.all([this.workspaces.list(), this.sessions.listAll()]);
		const sessionsByWorkspace = new Map<WorkspaceId, Session[]>();
		for (const session of sessions) {
			const workspaceSessions = sessionsByWorkspace.get(session.workspaceId);
			if (workspaceSessions === undefined) sessionsByWorkspace.set(session.workspaceId, [session]);
			else workspaceSessions.push(session);
		}
		return {
			workspaces: workspaces.map((workspace) => ({
				workspace,
				sessions: sessionsByWorkspace.get(workspace.id) ?? [],
			})),
		};
	}

	async getActiveWorkspaceCredential(workspaceId: WorkspaceId): Promise<WorkspaceCredential> {
		const workspace = await this.workspaces.get(workspaceId);
		return {
			workspaceId,
			workspaceRevision: workspace.revision,
			credential: await this.credentials.get(workspaceId, workspace.activeCredentialId),
		};
	}

	async listWorkspaceCredentials(workspaceId: WorkspaceId): Promise<WorkspaceCredentials> {
		const workspace = await this.workspaces.get(workspaceId);
		return {
			workspaceId,
			activeCredentialId: workspace.activeCredentialId,
			workspaceRevision: workspace.revision,
			credentials: await this.credentials.list(workspaceId),
		};
	}

	getWorkspaceGuard(workspaceId: WorkspaceId): Promise<Guard> {
		return this.guards.getByWorkspaceId(workspaceId);
	}

	updateWorkspaceGuard(input: UpdateGuardInput): Promise<Guard> {
		return this.guards.update(input);
	}

	listWorkspaceGuardRulePacks(workspaceId: WorkspaceId): Promise<GuardRulePacksResponse> {
		return this.guards.listRulePacks(workspaceId);
	}

	importWorkspaceGuardRulePacks(input: ImportGuardRulePacksInput): Promise<ImportGuardRulePacksResponse> {
		return this.guards.importRulePacks(input);
	}

	createCredential(workspaceId: WorkspaceId, input: CreateCredentialInput): Promise<Credential> {
		return this.credentials.create(workspaceId, input);
	}

	getCredential(workspaceId: WorkspaceId, id: CredentialId): Promise<Credential> {
		return this.credentials.get(workspaceId, id);
	}

	deleteCredential(input: DeleteCredentialInput): Promise<void> {
		return this.credentials.delete(input);
	}

	createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
		return this.workspaces.create(input);
	}

	activateWorkspaceCredential(input: ActivateWorkspaceCredentialInput): Promise<ActiveWorkspaceCredential> {
		return this.workspaces.activateCredential(input);
	}

	updateWorkspace(input: UpdateWorkspaceInput): Promise<Workspace> {
		return this.workspaces.update(input);
	}

	deleteWorkspace(input: DeleteWorkspaceInput): Promise<void> {
		return this.workspaces.delete(input);
	}

	createSession(input: CreateSessionInput): Promise<Session> {
		return this.sessions.create(input);
	}

	renameSession(input: UpdateSessionInput): Promise<Session> {
		return this.sessions.update(input);
	}

	deleteSession(input: DeleteSessionInput): Promise<void> {
		return this.sessions.delete(input);
	}

	getSession(id: SessionId): Promise<Session> {
		return this.sessions.get(id);
	}
}
