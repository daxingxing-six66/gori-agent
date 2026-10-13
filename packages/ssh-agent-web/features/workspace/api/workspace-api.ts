import type {
	CreateWorkspaceInput,
	TestWorkspaceConnectionInput,
	TestWorkspaceConnectionResult,
	CreateWorkspaceResult,
	Workspace,
	WorkspaceSessionTree,
} from "@/features/workspace/model/workspace";
import { parseRemoteSandboxProbe } from "@/features/workspace/model/workspace";
import { apiRequest } from "@/shared/api/client";
import type { SftpDirectoryEntry } from "@/features/sftp/model/sftp";

export const workspaceApi = {
	probeSandbox: async (workspaceId: string, signal?: AbortSignal) =>
		parseRemoteSandboxProbe(await apiRequest<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sandbox`, { method: "POST", signal })),
	testConnection: (input: TestWorkspaceConnectionInput, signal?: AbortSignal) =>
		apiRequest<TestWorkspaceConnectionResult>("/api/workspaces/test-connection", { method: "POST", body: input, signal }),
	browseDirectory: (input: TestWorkspaceConnectionInput, path: string, signal?: AbortSignal) =>
		apiRequest<{ path: string; entries: SftpDirectoryEntry[] }>("/api/workspaces/browse-directory", { method: "POST", body: { ...input, path }, signal }),
	getTree: (signal?: AbortSignal) => apiRequest<WorkspaceSessionTree>("/api/workspace-session-tree", { signal }),
	create: (input: CreateWorkspaceInput) =>
		apiRequest<CreateWorkspaceResult>("/api/workspaces", { method: "POST", body: input }),
	update: (workspaceId: string, input: { displayName: string; defaultCwd?: string; remoteDefaultCwd?: string; sandboxWritableRoots?: string[]; expectedRevision: number }) =>
		apiRequest<Workspace>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "PATCH", body: input }),
	rename: (workspaceId: string, displayName: string, expectedRevision: number) =>
		apiRequest<Workspace>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
			method: "PATCH",
			body: { displayName, expectedRevision },
		}),
	delete: (workspaceId: string, expectedRevision: number) =>
		apiRequest<void>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}?expectedRevision=${encodeURIComponent(expectedRevision)}`,
			{ method: "DELETE" },
		),
};
