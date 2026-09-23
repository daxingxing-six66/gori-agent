import { ManagementError } from "../../domain/errors.ts";
import type { Guard } from "../../domain/guard.ts";
import type { Clock, IdGenerator, WorkspaceId } from "../../domain/ids.ts";
import {
	type ActivateWorkspaceCredentialInput,
	type ActiveWorkspaceCredential,
	type CreateWorkspaceInput,
	type CreateWorkspaceResult,
	type DeleteWorkspaceInput,
	type UpdateWorkspaceInput,
	type Workspace,
} from "../../domain/workspace.ts";
import { validateWorkspaceConnection } from "../workspace-connection.ts";
import { buildCredential } from "../credential-factory.ts";
import type { CredentialRepository, CredentialSecretStore } from "../repositories/credential-repository.ts";
import type { GuardRepository } from "../repositories/guard-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { WorkspaceListFilter, WorkspaceRepository } from "../repositories/workspace-repository.ts";
import type { SshConnectionPoolControl } from "../ssh-channel-broker.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import { requireDisplayName, requireNonEmpty, requirePositiveRevision } from "../validation.ts";

export interface WorkspaceService {
	create(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult>;
	get(id: WorkspaceId): Promise<Workspace>;
	list(filter?: WorkspaceListFilter): Promise<Workspace[]>;
	activateCredential(input: ActivateWorkspaceCredentialInput): Promise<ActiveWorkspaceCredential>;
	update(input: UpdateWorkspaceInput): Promise<Workspace>;
	delete(input: DeleteWorkspaceInput): Promise<void>;
}

export interface DefaultWorkspaceServiceOptions {
	workspaces: WorkspaceRepository;
	credentials: CredentialRepository;
	secrets: CredentialSecretStore;
	sessions: SessionRepository;
	guards: GuardRepository;
	transactions: TransactionRunner;
	clock: Clock;
	ids: IdGenerator;
	connections?: Pick<SshConnectionPoolControl, "invalidateWorkspace">;
}

export class DefaultWorkspaceService implements WorkspaceService {
	private readonly workspaces: WorkspaceRepository;
	private readonly credentials: CredentialRepository;
	private readonly secrets: CredentialSecretStore;
	private readonly sessions: SessionRepository;
	private readonly guards: GuardRepository;
	private readonly transactions: TransactionRunner;
	private readonly clock: Clock;
	private readonly ids: IdGenerator;
	private readonly connections?: Pick<SshConnectionPoolControl, "invalidateWorkspace">;

	constructor(options: DefaultWorkspaceServiceOptions) {
		this.workspaces = options.workspaces;
		this.credentials = options.credentials;
		this.secrets = options.secrets;
		this.sessions = options.sessions;
		this.guards = options.guards;
		this.transactions = options.transactions;
		this.clock = options.clock;
		this.ids = options.ids;
		this.connections = options.connections;
	}

	async create(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
		const displayName = requireDisplayName(input.displayName);
		const { host, connection } = validateWorkspaceConnection(input);
		if (!isWorkspaceEnvironment(input.environment)) {
			throw new ManagementError("validation_error", "environment is invalid", "environment");
		}
		const defaultCwd = requireNonEmpty(input.defaultCwd, "defaultCwd", 4096);

		const now = this.clock.now();
		const workspaceId = this.ids.next();
		const activeCredential = buildCredential({
			id: this.ids.next(),
			workspaceId,
			input: input.credential,
			now,
		});
		const workspace: Workspace = {
			id: workspaceId,
			displayName,
			environment: input.environment,
			host: {
				...host,
				hostKey: null,
			},
			activeCredentialId: activeCredential.id,
			defaultCwd,
			remoteDefaultCwd: requireRemoteDirectory(input.remoteDefaultCwd ?? "/"),
			connection,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		};
		const guard: Guard = {
			id: this.ids.next(),
			workspaceId: workspace.id,
			enabled: false,
			rules: [],
			revision: 1,
			createdAt: now,
			updatedAt: now,
		};

		await this.transactions.run(async () => {
			await this.workspaces.insert(workspace);
			await this.credentials.insert(activeCredential, true);
			await this.secrets.put(activeCredential.id, activeCredential.authVersion, input.credential.secret);
			await this.guards.insert(guard);
		});
		return { workspace, activeCredential };
	}

	async get(id: WorkspaceId): Promise<Workspace> {
		const workspace = await this.workspaces.findById(id);
		if (!workspace) throw new ManagementError("not_found", `Workspace not found: ${id}`);
		return workspace;
	}

	list(filter?: WorkspaceListFilter): Promise<Workspace[]> {
		return this.workspaces.list(filter);
	}

	async activateCredential(input: ActivateWorkspaceCredentialInput): Promise<ActiveWorkspaceCredential> {
		requirePositiveRevision(input.expectedRevision);
		const result = await this.transactions.run(async () => {
			const current = await this.get(input.workspaceId);
			if (current.revision !== input.expectedRevision) {
				throw new ManagementError("revision_conflict", "Workspace was modified by another request");
			}
			const credential = await this.credentials.findById(input.workspaceId, input.credentialId);
			if (!credential) throw new ManagementError("not_found", `Credential not found: ${input.credentialId}`);
			if (current.activeCredentialId === credential.id) {
				return { workspace: current, activeCredential: credential };
			}
			const updated: Workspace = {
				...current,
				activeCredentialId: credential.id,
				revision: current.revision + 1,
				updatedAt: this.clock.now(),
			};
			if (!(await this.credentials.activate(input.workspaceId, credential.id))) {
				throw new ManagementError("not_found", `Credential not found: ${credential.id}`);
			}
			if (!(await this.workspaces.update(updated, input.expectedRevision))) {
				throw new ManagementError("revision_conflict", "Workspace was modified by another request");
			}
			return { workspace: updated, activeCredential: credential };
		});
		if (result.workspace.revision !== input.expectedRevision)
			this.connections?.invalidateWorkspace(input.workspaceId);
		return result;
	}

	async update(input: UpdateWorkspaceInput): Promise<Workspace> {
		requirePositiveRevision(input.expectedRevision);
		const current = await this.get(input.id);
		if (current.revision !== input.expectedRevision) {
			throw new ManagementError("revision_conflict", "Workspace was modified by another request");
		}
		const updated: Workspace = {
			...current,
			displayName: requireDisplayName(input.displayName),
			defaultCwd: input.defaultCwd === undefined ? current.defaultCwd : requireNonEmpty(input.defaultCwd, "defaultCwd", 4096),
			remoteDefaultCwd: input.remoteDefaultCwd === undefined ? current.remoteDefaultCwd ?? "/" : requireRemoteDirectory(input.remoteDefaultCwd),
			revision: current.revision + 1,
			updatedAt: this.clock.now(),
		};
		if (!(await this.workspaces.update(updated, input.expectedRevision))) {
			throw new ManagementError("revision_conflict", "Workspace was modified by another request");
		}
		return updated;
	}

	async delete(input: DeleteWorkspaceInput): Promise<void> {
		requirePositiveRevision(input.expectedRevision);
		if ((await this.sessions.countByWorkspaceId(input.id)) > 0) {
			throw new ManagementError("workspace_has_sessions", "Workspace still contains Sessions");
		}
		const deleted = await this.workspaces.delete(input.id, input.expectedRevision);
		if (!deleted) {
			if (!(await this.workspaces.findById(input.id))) {
				throw new ManagementError("not_found", `Workspace not found: ${input.id}`);
			}
			throw new ManagementError("revision_conflict", "Workspace was modified by another request");
		}
		this.connections?.invalidateWorkspace(input.id);
	}
}

function isWorkspaceEnvironment(value: string): value is Workspace["environment"] {
	return value === "production" || value === "staging" || value === "development" || value === "other";
}

function requireRemoteDirectory(value: string): string {
	const path = requireNonEmpty(value, "remoteDefaultCwd", 4096);
	if (!path.startsWith("/") || path.includes("\0")) {
		throw new ManagementError("validation_error", "remoteDefaultCwd must be an absolute remote path", "remoteDefaultCwd");
	}
	return path;
}
