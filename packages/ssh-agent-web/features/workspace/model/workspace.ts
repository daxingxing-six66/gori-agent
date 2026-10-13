import { validSandboxFactRoots } from "./sandbox-writable-roots";
export { isRemoteSandboxRoot, isCanonicalRemoteSandboxRoot } from "./sandbox-writable-roots";
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
	/** Remote SSH/SFTP default directory. */
	remoteDefaultCwd?: string;
	sandboxWritableRoots?: string[];
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
	/** Remote SSH/SFTP default directory. */
	remoteDefaultCwd?: string;
	sandboxWritableRoots?: string[];
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

export type RemoteSandboxProbe =
	| { mode: "workspace_write"; backend: "landlock"; enforcement: "full"; abi: number; sandboxRoot: string; sandboxRoots?: string[] }
	| { mode: "workspace_write"; backend: "bubblewrap"; enforcement: "full"; bubblewrapVersion: string; sandboxRoot: string; sandboxRoots?: string[] };

export function parseRemoteSandboxProbe(value: unknown): RemoteSandboxProbe {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote sandbox probe response");
	const facts = value as Record<string, unknown>;
	if (facts.mode !== "workspace_write" || facts.enforcement !== "full" ||
		typeof facts.sandboxRoot !== "string" || !validSandboxFactRoots(facts)) {
		throw new Error("Invalid remote sandbox probe response");
	}
	if (facts.backend === "landlock" && facts.bubblewrapVersion === undefined && typeof facts.abi === "number" &&
		Number.isSafeInteger(facts.abi) && facts.abi >= 5)
		return { mode: "workspace_write", backend: "landlock", enforcement: "full",
			abi: facts.abi, sandboxRoot: facts.sandboxRoot,
			...(facts.sandboxRoots === undefined ? {} : { sandboxRoots: facts.sandboxRoots as string[] }) };
	if (facts.backend === "bubblewrap" && facts.abi === undefined && facts.launcherVersion === undefined &&
		typeof facts.bubblewrapVersion === "string" &&
		/^[0-9]+\.[0-9]+\.[0-9]+$/.test(facts.bubblewrapVersion))
		return { mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
			bubblewrapVersion: facts.bubblewrapVersion, sandboxRoot: facts.sandboxRoot,
			...(facts.sandboxRoots === undefined ? {} : { sandboxRoots: facts.sandboxRoots as string[] }) };
	throw new Error("Invalid remote sandbox probe response");
}
