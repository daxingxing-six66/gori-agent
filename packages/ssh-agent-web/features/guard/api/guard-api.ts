import type {
	Guard,
	GuardRulePacksResponse,
	ImportGuardRulePacksResponse,
	UpdateGuardRuleInput,
} from "@/features/guard/model/guard";
import { apiRequest } from "@/shared/api/client";

export const guardApi = {
	get: (workspaceId: string, signal?: AbortSignal) =>
		apiRequest<Guard>(`/api/workspaces/${encodeURIComponent(workspaceId)}/guard`, { signal }),
	update: (workspaceId: string, enabled: boolean, rules: UpdateGuardRuleInput[], expectedRevision: number) =>
		apiRequest<Guard>(`/api/workspaces/${encodeURIComponent(workspaceId)}/guard`, {
			method: "PATCH",
			body: {
				enabled,
				rules: rules.map((rule) => ({
					...(rule.id === undefined ? {} : { id: rule.id }),
					displayName: rule.displayName,
					pattern: rule.pattern,
					match: rule.match,
					...(rule.reason === undefined ? {} : { reason: rule.reason }),
					enabled: rule.enabled,
				})),
				expectedRevision,
			},
		}),
	listRulePacks: (workspaceId: string, signal?: AbortSignal) =>
		apiRequest<GuardRulePacksResponse>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/guard/rule-packs`,
			{ signal },
		),
	importRulePacks: (workspaceId: string, packIds: string[], expectedRevision: number) =>
		apiRequest<ImportGuardRulePacksResponse>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/guard/rule-packs/import`,
			{
				method: "POST",
				body: { packIds, expectedRevision },
			},
		),
};
