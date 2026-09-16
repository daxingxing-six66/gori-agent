import type { CommandGuardRule } from "../../domain/guard.ts";
import type { WorkspaceId } from "../../domain/ids.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { GuardRepository } from "../repositories/guard-repository.ts";

export interface CommandGuardDecision {
	allowed: boolean;
	guardRevision?: number;
	matchedRule?: CommandGuardRule;
}

export interface CommandGuardEvaluator {
	evaluate(workspaceId: WorkspaceId, command: string): Promise<CommandGuardDecision>;
}

export class DefaultCommandGuardEvaluator implements CommandGuardEvaluator {
	private readonly guards: GuardRepository;

	constructor(guards: GuardRepository) {
		this.guards = guards;
	}

	async evaluate(workspaceId: WorkspaceId, command: string): Promise<CommandGuardDecision> {
		const guard = await this.guards.findByWorkspaceId(workspaceId);
		if (!guard || !guard.enabled) return { allowed: true, ...(guard ? { guardRevision: guard.revision } : {}) };
		for (const rule of guard.rules) {
			if (!rule.enabled) continue;
			let matched: boolean;
			try {
				matched = matches(rule, command);
			} catch (error) {
				throw new SshAgentError(
					{
						code: "guard_configuration_invalid",
						category: "guard",
						phase: "guard_check",
						message: "Workspace Guard contains an invalid regular expression",
						retryable: false,
						workspaceId,
						safeDetails: { guardRevision: guard.revision, ruleId: rule.id },
					},
					error instanceof Error ? error : undefined,
				);
			}
			if (matched) return { allowed: false, guardRevision: guard.revision, matchedRule: rule };
		}
		return { allowed: true, guardRevision: guard.revision };
	}
}

function matches(rule: CommandGuardRule, command: string): boolean {
	switch (rule.match) {
		case "contains":
			return command.includes(rule.pattern);
		case "starts_with":
			return command.startsWith(rule.pattern);
		case "regex":
			return new RegExp(rule.pattern).test(command);
	}
}
