import type { CredentialId, WorkspaceId } from "./ids.ts";

export type CredentialType = "private_key" | "password";

interface CredentialBase {
	id: CredentialId;
	workspaceId: WorkspaceId;
	displayName: string;
	type: CredentialType;
	remoteUser: string;
	/** Rotates when authentication material or remoteUser changes. */
	authVersion: number;
	/** Rotates on every persisted update for optimistic concurrency. */
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface PrivateKeyCredential extends CredentialBase {
	type: "private_key";
	publicKeyFingerprint?: string;
	hasPassphrase: boolean;
}

export interface PasswordCredential extends CredentialBase {
	type: "password";
}

/** Safe metadata. It never contains a password, private key, or passphrase. */
export type Credential = PrivateKeyCredential | PasswordCredential;

export interface PrivateKeyCredentialSecret {
	type: "private_key";
	privateKey: string;
	passphrase?: string;
}

export interface PasswordCredentialSecret {
	type: "password";
	password: string;
}

/** Write-only authentication material. It must never appear in responses or logs. */
export type CredentialSecret = PrivateKeyCredentialSecret | PasswordCredentialSecret;

export interface CreateCredentialInput {
	displayName: string;
	remoteUser: string;
	secret: CredentialSecret;
}
