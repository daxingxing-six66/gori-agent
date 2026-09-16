import type { Session } from "@/features/session/model/session";
import type { CreateCredentialInput, Credential } from "@/features/credential/model/credential";

export type WorkspaceEnvironment = "production" | "staging" | "development" | "other";
export const DEFAULT_WORKSPACE_CWD = "/";

export interface WorkspaceHostKey {
	algorithm: string;
	fingerprint: string;
	verifiedAt: number;
}

export interface Workspace {
	id: string;
	displayName: string;
	environment: WorkspaceEnvironment;
	host: {
		hostname: string;
		port: number;
		hostKey: WorkspaceHostKey | null;
	};
	activeCredentialId: string;
	defaultCwd: string;
	connection: {
		connectTimeoutMs: number;
		keepaliveIntervalMs: number;
		keepaliveMaxCount: number;
	};
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface WorkspaceSessionTreeItem {
	workspace: Workspace;
	sessions: Session[];
}

export interface WorkspaceSessionTree {
	workspaces: WorkspaceSessionTreeItem[];
}

export interface CreateWorkspaceInput {
	displayName: string;
	environment: WorkspaceEnvironment;
	host: Pick<Workspace["host"], "hostname" | "port">;
	credential: CreateCredentialInput;
	defaultCwd: string;
	connection?: Partial<Workspace["connection"]>;
}

export interface CreateWorkspaceResult {
	workspace: Workspace;
	activeCredential: Credential;
}

export interface ActivateWorkspaceCredentialResult {
	workspace: Workspace;
	activeCredential: Credential;
}
