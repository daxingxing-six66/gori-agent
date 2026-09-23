import type { CreateCredentialInput, Credential } from "./credential.ts";
import type { CredentialId, WorkspaceId } from "./ids.ts";

export type WorkspaceEnvironment = "production" | "staging" | "development" | "other";

export interface VerifiedHostKey {
	algorithm: string;
	fingerprint: string;
	verifiedAt: number;
}

export interface WorkspaceHostAddress {
	hostname: string;
	port: number;
}

export interface WorkspaceHost extends WorkspaceHostAddress {
	hostKey: VerifiedHostKey | null;
}

export interface WorkspaceConnectionOptions {
	connectTimeoutMs: number;
	keepaliveIntervalMs: number;
	keepaliveMaxCount: number;
}

export const DEFAULT_WORKSPACE_CONNECTION_OPTIONS: WorkspaceConnectionOptions = {
	connectTimeoutMs: 10_000,
	keepaliveIntervalMs: 15_000,
	keepaliveMaxCount: 3,
};

export interface Workspace {
	id: WorkspaceId;
	displayName: string;
	environment: WorkspaceEnvironment;
	host: WorkspaceHost;
	activeCredentialId: CredentialId;
	/** Local default inherited by new sessions. */
	defaultCwd: string;
	/** Remote SSH/SFTP directory; omitted by older clients, defaults to /. */
	remoteDefaultCwd?: string;
	connection: WorkspaceConnectionOptions;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface CreateWorkspaceInput {
	displayName: string;
	environment: WorkspaceEnvironment;
	host: WorkspaceHostAddress;
	credential: CreateCredentialInput;
	/** Local default inherited by new sessions. */
	defaultCwd: string;
	/** Remote SSH/SFTP directory; omitted by older clients, defaults to /. */
	remoteDefaultCwd?: string;
	connection?: Partial<WorkspaceConnectionOptions>;
}

export interface CreateWorkspaceResult {
	workspace: Workspace;
	activeCredential: Credential;
}

export interface ActivateWorkspaceCredentialInput {
	workspaceId: WorkspaceId;
	credentialId: CredentialId;
	expectedRevision: number;
}

export interface ActiveWorkspaceCredential {
	workspace: Workspace;
	activeCredential: Credential;
}

export interface UpdateWorkspaceInput {
	id: WorkspaceId;
	displayName: string;
	defaultCwd?: string;
	remoteDefaultCwd?: string;
	expectedRevision: number;
}

export type RenameWorkspaceInput = UpdateWorkspaceInput;

export interface DeleteWorkspaceInput {
	id: WorkspaceId;
	expectedRevision: number;
}
