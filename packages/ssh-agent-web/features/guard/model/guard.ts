export type GuardMatch = "contains" | "starts_with" | "regex";
export type GuardRuleLevel = "critical" | "strict";
export type GuardRuleSource = "builtin" | "user";

export interface GuardRule {
	id: string;
	displayName: string;
	pattern: string;
	match: GuardMatch;
	reason?: string;
	enabled: boolean;
	readonly source?: GuardRuleSource;
	readonly originRuleId?: string;
	readonly packId?: string;
	readonly packVersion?: string;
	readonly level?: GuardRuleLevel;
}

export interface UpdateGuardRuleInput {
	id?: string;
	displayName: string;
	pattern: string;
	match: GuardMatch;
	reason?: string;
	enabled: boolean;
}

export interface GuardRuleDraft extends UpdateGuardRuleInput {
	clientKey: string;
	readonly source?: GuardRuleSource;
	readonly originRuleId?: string;
	readonly packId?: string;
	readonly packVersion?: string;
	readonly level?: GuardRuleLevel;
}

export interface Guard {
	id: string;
	workspaceId: string;
	enabled: boolean;
	rules: GuardRule[];
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface GuardRulePackSummary {
	id: string;
	name: string;
	description: string;
	version: string;
	ruleCount: number;
	importedRuleCount: number;
	availableRuleCount: number;
	recommended: boolean;
}

export interface GuardRulePacksResponse {
	workspaceId: string;
	guardRevision: number;
	packs: GuardRulePackSummary[];
}

export interface GuardRulePackImportResult {
	packId: string;
	importedCount: number;
	skippedCount: number;
}

export interface ImportGuardRulePacksResponse {
	guard: Guard;
	results: GuardRulePackImportResult[];
}
