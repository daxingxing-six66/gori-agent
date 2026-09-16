import type { CreateCredentialInput, Credential } from "../../domain/credential.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { Clock, CredentialId, IdGenerator, WorkspaceId } from "../../domain/ids.ts";
import { buildCredential } from "../credential-factory.ts";
import type { CredentialRepository, CredentialSecretStore } from "../repositories/credential-repository.ts";
import type { WorkspaceRepository } from "../repositories/workspace-repository.ts";
import type { SshConnectionPoolControl } from "../ssh-channel-broker.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import { requirePositiveRevision } from "../validation.ts";

export interface DeleteCredentialInput {
	workspaceId: WorkspaceId;
	id: CredentialId;
	expectedRevision: number;
}

export interface CredentialService {
	create(workspaceId: WorkspaceId, input: CreateCredentialInput): Promise<Credential>;
	get(workspaceId: WorkspaceId, id: CredentialId): Promise<Credential>;
	list(workspaceId: WorkspaceId): Promise<Credential[]>;
	delete(input: DeleteCredentialInput): Promise<void>;
}

export interface DefaultCredentialServiceOptions {
	credentials: CredentialRepository;
	secrets: CredentialSecretStore;
	workspaces: WorkspaceRepository;
	transactions: TransactionRunner;
	clock: Clock;
	ids: IdGenerator;
	connections?: Pick<SshConnectionPoolControl, "invalidateCredential">;
}

export class DefaultCredentialService implements CredentialService {
	private readonly credentials: CredentialRepository;
	private readonly secrets: CredentialSecretStore;
	private readonly workspaces: WorkspaceRepository;
	private readonly transactions: TransactionRunner;
	private readonly clock: Clock;
	private readonly ids: IdGenerator;
	private readonly connections?: Pick<SshConnectionPoolControl, "invalidateCredential">;

	constructor(options: DefaultCredentialServiceOptions) {
		this.credentials = options.credentials;
		this.secrets = options.secrets;
		this.workspaces = options.workspaces;
		this.transactions = options.transactions;
		this.clock = options.clock;
		this.ids = options.ids;
		this.connections = options.connections;
	}

	async create(workspaceId: WorkspaceId, input: CreateCredentialInput): Promise<Credential> {
		return this.transactions.run(async () => {
			if (!(await this.workspaces.findById(workspaceId))) {
				throw new ManagementError("not_found", `Workspace not found: ${workspaceId}`);
			}
			const credential = buildCredential({
				id: this.ids.next(),
				workspaceId,
				input,
				now: this.clock.now(),
			});
			await this.credentials.insert(credential, false);
			await this.secrets.put(credential.id, credential.authVersion, input.secret);
			return credential;
		});
	}

	async get(workspaceId: WorkspaceId, id: CredentialId): Promise<Credential> {
		const credential = await this.credentials.findById(workspaceId, id);
		if (!credential) throw new ManagementError("not_found", `Credential not found: ${id}`);
		return credential;
	}

	async list(workspaceId: WorkspaceId): Promise<Credential[]> {
		if (!(await this.workspaces.findById(workspaceId))) {
			throw new ManagementError("not_found", `Workspace not found: ${workspaceId}`);
		}
		return this.credentials.listByWorkspaceId(workspaceId);
	}

	async delete(input: DeleteCredentialInput): Promise<void> {
		requirePositiveRevision(input.expectedRevision);
		await this.transactions.run(async () => {
			const workspace = await this.workspaces.findById(input.workspaceId);
			if (!workspace) throw new ManagementError("not_found", `Workspace not found: ${input.workspaceId}`);
			const credential = await this.credentials.findById(input.workspaceId, input.id);
			if (!credential) throw new ManagementError("not_found", `Credential not found: ${input.id}`);
			if (workspace.activeCredentialId === credential.id) {
				throw new ManagementError("active_credential_in_use", "The active Credential cannot be deleted");
			}
			if (credential.revision !== input.expectedRevision) {
				throw new ManagementError("revision_conflict", "Credential was modified by another request");
			}
			if (!(await this.credentials.delete(input.workspaceId, input.id, input.expectedRevision))) {
				throw new ManagementError("revision_conflict", "Credential was modified by another request");
			}
			await this.secrets.deleteAll(input.id);
		});
		this.connections?.invalidateCredential(input.id);
	}
}
