import type { GuardId, WorkspaceId } from "./ids.ts";

export type CommandGuardMatch = "contains" | "starts_with" | "regex";
export type CommandGuardRuleSource = "builtin" | "user";
export type CommandGuardRuleLevel = "critical" | "strict";

export interface CommandGuardRule {
	id: string;
	displayName: string;
	pattern: string;
	match: CommandGuardMatch;
	reason?: string;
	enabled: boolean;
	source: CommandGuardRuleSource;
	originRuleId?: string;
	packId?: string;
	packVersion?: string;
	level: CommandGuardRuleLevel;
}

export interface UpdateCommandGuardRuleInput {
	id?: string;
	displayName: string;
	pattern: string;
	match: CommandGuardMatch;
	reason?: string;
	enabled: boolean;
}

/** One independently persisted Guard is bound to each Workspace. */
export interface Guard {
	id: GuardId;
	workspaceId: WorkspaceId;
	enabled: boolean;
	rules: CommandGuardRule[];
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface UpdateGuardInput {
	workspaceId: WorkspaceId;
	enabled: boolean;
	rules: UpdateCommandGuardRuleInput[];
	expectedRevision: number;
}
