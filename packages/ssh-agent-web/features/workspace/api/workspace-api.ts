import type {
	CreateWorkspaceInput,
	TestWorkspaceConnectionInput,
	TestWorkspaceConnectionResult,
	CreateWorkspaceResult,
	Workspace,
	WorkspaceSessionTree,
} from "@/features/workspace/model/workspace";
import { apiRequest } from "@/shared/api/client";

export const workspaceApi = {
	testConnection: (input: TestWorkspaceConnectionInput, signal?: AbortSignal) =>
		apiRequest<TestWorkspaceConnectionResult>("/api/workspaces/test-connection", { method: "POST", body: input, signal }),
	getTree: (signal?: AbortSignal) => apiRequest<WorkspaceSessionTree>("/api/workspace-session-tree", { signal }),
	create: (input: CreateWorkspaceInput) =>
		apiRequest<CreateWorkspaceResult>("/api/workspaces", { method: "POST", body: input }),
	update: (workspaceId: string, input: { displayName: string; defaultCwd?: string; expectedRevision: number }) =>
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
