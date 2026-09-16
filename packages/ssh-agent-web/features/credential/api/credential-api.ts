import type {
	CreateCredentialInput,
	Credential,
	WorkspaceCredential,
	WorkspaceCredentials,
} from "@/features/credential/model/credential";
import type { ActivateWorkspaceCredentialResult } from "@/features/workspace/model/workspace";
import { apiRequest } from "@/shared/api/client";

export const credentialApi = {
	create: (workspaceId: string, input: CreateCredentialInput) =>
		apiRequest<Credential>(`/api/workspaces/${encodeURIComponent(workspaceId)}/credentials`, {
			method: "POST",
			body: input,
		}),
	list: (workspaceId: string, signal?: AbortSignal) =>
		apiRequest<WorkspaceCredentials>(`/api/workspaces/${encodeURIComponent(workspaceId)}/credentials`, { signal }),
	get: (workspaceId: string, credentialId: string, signal?: AbortSignal) =>
		apiRequest<Credential>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(credentialId)}`,
			{ signal },
		),
	getActive: (workspaceId: string, signal?: AbortSignal) =>
		apiRequest<WorkspaceCredential>(`/api/workspaces/${encodeURIComponent(workspaceId)}/active-credential`, { signal }),
	activate: (workspaceId: string, credentialId: string, expectedRevision: number) =>
		apiRequest<ActivateWorkspaceCredentialResult>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/active-credential`,
			{ method: "PUT", body: { credentialId, expectedRevision } },
		),
	delete: (workspaceId: string, credentialId: string, expectedRevision: number) =>
		apiRequest<void>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(credentialId)}?expectedRevision=${encodeURIComponent(expectedRevision)}`,
			{ method: "DELETE" },
		),
};
