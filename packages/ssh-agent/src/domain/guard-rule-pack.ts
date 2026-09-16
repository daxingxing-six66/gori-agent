import type { CommandGuardMatch, CommandGuardRuleLevel, Guard } from "./guard.ts";
import type { WorkspaceId } from "./ids.ts";

export interface GuardRulePackRuleDefinition {
	originRuleId: string;
	displayName: string;
	pattern: string;
	match: CommandGuardMatch;
	reason?: string;
	enabled: boolean;
	level: CommandGuardRuleLevel;
}

export interface GuardRulePackDefinition {
	id: string;
	name: string;
	description: string;
	version: string;
	recommended: boolean;
	rules: readonly GuardRulePackRuleDefinition[];
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
	workspaceId: WorkspaceId;
	guardRevision: number;
	packs: GuardRulePackSummary[];
}

export interface ImportGuardRulePacksInput {
	workspaceId: WorkspaceId;
	packIds: string[];
	expectedRevision: number;
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
