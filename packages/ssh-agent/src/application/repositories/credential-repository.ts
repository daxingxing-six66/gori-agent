import type { Credential, CredentialSecret } from "../../domain/credential.ts";
import type { CredentialId, WorkspaceId } from "../../domain/ids.ts";

export interface CredentialRepository {
	findById(workspaceId: WorkspaceId, id: CredentialId): Promise<Credential | undefined>;
	listByWorkspaceId(workspaceId: WorkspaceId): Promise<Credential[]>;
	insert(credential: Credential, active: boolean): Promise<void>;
	update(credential: Credential, expectedRevision: number): Promise<boolean>;
	activate(workspaceId: WorkspaceId, id: CredentialId): Promise<boolean>;
	delete(workspaceId: WorkspaceId, id: CredentialId, expectedRevision: number): Promise<boolean>;
}

/** Secret storage remains separate so metadata reads never load plaintext secrets. */
export interface CredentialSecretStore {
	put(credentialId: CredentialId, authVersion: number, secret: CredentialSecret): Promise<void>;
	get(credentialId: CredentialId, authVersion: number): Promise<CredentialSecret | undefined>;
	deleteAll(credentialId: CredentialId): Promise<void>;
}
