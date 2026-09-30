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
	/** Local default inherited by new sessions. */
	defaultCwd: string;
	/** Remote SSH/SFTP directory; omitted by older clients, defaults to /. */
	remoteDefaultCwd?: string;
	remoteSandboxRoot?: string;
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
	/** Local default inherited by new sessions. */
	defaultCwd: string;
	/** Remote SSH/SFTP directory; omitted by older clients, defaults to /. */
	remoteDefaultCwd?: string;
	remoteSandboxRoot?: string;
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

export type TestWorkspaceConnectionInput = Pick<CreateWorkspaceInput, "host" | "credential" | "connection">;
export interface TestWorkspaceConnectionResult { success: true; }

export interface RemoteSandboxProbe {
	mode: "workspace_write";
	backend: "landlock";
	enforcement: "full";
	abi: number;
	sandboxRoot: string;
}

export function parseRemoteSandboxProbe(value: unknown): RemoteSandboxProbe {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote sandbox probe response");
	const facts = value as Record<string, unknown>;
	if (facts.mode !== "workspace_write" || facts.backend !== "landlock" || facts.enforcement !== "full" ||
		typeof facts.abi !== "number" || !Number.isSafeInteger(facts.abi) || facts.abi < 5 ||
		typeof facts.sandboxRoot !== "string" || !isRemoteSandboxRoot(facts.sandboxRoot)) {
		throw new Error("Invalid remote sandbox probe response");
	}
	return { mode: facts.mode, backend: facts.backend, enforcement: facts.enforcement,
		abi: facts.abi, sandboxRoot: facts.sandboxRoot };
}

export function isRemoteSandboxRoot(path: string): boolean {
	if (!path.startsWith("/") || path.includes("\0") || path.includes("\n") || path.length > 4096) return false;
	const segments: string[] = [];
	for (const part of path.split("/")) {
		if (part === "..") segments.pop();
		else if (part !== "" && part !== ".") segments.push(part);
	}
	return segments.length > 0;
}
