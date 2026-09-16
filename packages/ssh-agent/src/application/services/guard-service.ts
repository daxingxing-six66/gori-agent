import { ManagementError } from "../../domain/errors.ts";
import type { CommandGuardRule, Guard, UpdateGuardInput } from "../../domain/guard.ts";
import type {
	GuardRulePacksResponse,
	ImportGuardRulePacksInput,
	ImportGuardRulePacksResponse,
} from "../../domain/guard-rule-pack.ts";
import type { Clock, IdGenerator, WorkspaceId } from "../../domain/ids.ts";
import type { GuardRepository } from "../repositories/guard-repository.ts";
import { requireDisplayName, requireNonEmpty, requirePositiveRevision } from "../validation.ts";
import type { GuardRulePackCatalog } from "./guard-rule-pack-catalog.ts";

export interface GuardService {
	getByWorkspaceId(workspaceId: WorkspaceId): Promise<Guard>;
	update(input: UpdateGuardInput): Promise<Guard>;
	listRulePacks(workspaceId: WorkspaceId): Promise<GuardRulePacksResponse>;
	importRulePacks(input: ImportGuardRulePacksInput): Promise<ImportGuardRulePacksResponse>;
}

export interface DefaultGuardServiceOptions {
	guards: GuardRepository;
	clock: Clock;
	ids: IdGenerator;
	rulePacks: GuardRulePackCatalog;
}

export class DefaultGuardService implements GuardService {
	private readonly guards: GuardRepository;
	private readonly clock: Clock;
	private readonly ids: IdGenerator;
	private readonly rulePacks: GuardRulePackCatalog;

	constructor(options: DefaultGuardServiceOptions) {
		this.guards = options.guards;
		this.clock = options.clock;
		this.ids = options.ids;
		this.rulePacks = options.rulePacks;
	}

	async getByWorkspaceId(workspaceId: WorkspaceId): Promise<Guard> {
		const guard = await this.guards.findByWorkspaceId(workspaceId);
		if (!guard) throw new ManagementError("not_found", `Guard not found for Workspace: ${workspaceId}`);
		return guard;
	}

	async update(input: UpdateGuardInput): Promise<Guard> {
		requirePositiveRevision(input.expectedRevision);
		const current = await this.getByWorkspaceId(input.workspaceId);
		if (current.revision !== input.expectedRevision) {
			throw new ManagementError("revision_conflict", "Guard was modified by another request");
		}
		const existingRulesById = new Map(current.rules.map((rule) => [rule.id, rule]));
		const existingRuleIds = new Set(existingRulesById.keys());
		const submittedRuleIds = new Set<string>();
		const rules = input.rules.map((rule) => {
			const id =
				rule.id === undefined
					? this.nextRuleId(existingRuleIds, submittedRuleIds)
					: requireNonEmpty(rule.id, "rules.id", 128);
			if (rule.id !== undefined && !existingRuleIds.has(id)) {
				throw new ManagementError(
					"validation_error",
					`Guard rule does not belong to the current Guard: ${id}`,
					"rules.id",
				);
			}
			if (submittedRuleIds.has(id)) {
				throw new ManagementError("validation_error", `Duplicate Guard rule id: ${id}`, "rules.id");
			}
			submittedRuleIds.add(id);
			if (rule.match !== "contains" && rule.match !== "starts_with" && rule.match !== "regex") {
				throw new ManagementError("validation_error", `Invalid Guard match mode: ${rule.match}`, "rules.match");
			}
			if (rule.match === "regex") {
				try {
					new RegExp(rule.pattern);
				} catch (error) {
					throw new ManagementError(
						"validation_error",
						`Invalid regular expression for Guard rule ${id}`,
						"rules.pattern",
						error instanceof Error ? error : undefined,
					);
				}
			}
			const existing = existingRulesById.get(id);
			return {
				id,
				displayName: requireDisplayName(rule.displayName, "rules.displayName"),
				pattern: requireNonEmpty(rule.pattern, "rules.pattern", 4096),
				match: rule.match,
				...(rule.reason === undefined ? {} : { reason: requireNonEmpty(rule.reason, "rules.reason", 512) }),
				enabled: rule.enabled,
				...(existing === undefined
					? { source: "user" as const, level: "critical" as const }
					: sourceMetadata(existing)),
			};
		});
		const updated: Guard = {
			...current,
			enabled: input.enabled,
			rules,
			revision: current.revision + 1,
			updatedAt: this.clock.now(),
		};
		if (!(await this.guards.update(updated, input.expectedRevision))) {
			throw new ManagementError("revision_conflict", "Guard was modified by another request");
		}
		return updated;
	}

	async listRulePacks(workspaceId: WorkspaceId): Promise<GuardRulePacksResponse> {
		const guard = await this.getByWorkspaceId(workspaceId);
		const importedOriginIds = new Set(
			guard.rules.flatMap((rule) => (rule.originRuleId === undefined ? [] : [rule.originRuleId])),
		);
		return {
			workspaceId,
			guardRevision: guard.revision,
			packs: this.rulePacks.list().map((pack) => {
				const importedRuleCount = pack.rules.filter((rule) => importedOriginIds.has(rule.originRuleId)).length;
				return {
					id: pack.id,
					name: pack.name,
					description: pack.description,
					version: pack.version,
					ruleCount: pack.rules.length,
					importedRuleCount,
					availableRuleCount: pack.rules.length - importedRuleCount,
					recommended: pack.recommended,
				};
			}),
		};
	}

	async importRulePacks(input: ImportGuardRulePacksInput): Promise<ImportGuardRulePacksResponse> {
		requirePositiveRevision(input.expectedRevision);
		const current = await this.getByWorkspaceId(input.workspaceId);
		if (current.revision !== input.expectedRevision) {
			throw new ManagementError("revision_conflict", "Guard was modified by another request");
		}
		if (input.packIds.length === 0) {
			throw new ManagementError("validation_error", "packIds must not be empty", "packIds");
		}
		const requestedIds = new Set<string>();
		const packs = input.packIds.map((packId) => {
			const id = requireNonEmpty(packId, "packIds", 128);
			if (requestedIds.has(id)) {
				throw new ManagementError("validation_error", `Duplicate Guard rule pack id: ${id}`, "packIds");
			}
			requestedIds.add(id);
			const pack = this.rulePacks.find(id);
			if (pack === undefined) {
				throw new ManagementError("validation_error", `Unknown Guard rule pack: ${id}`, "packIds");
			}
			return pack;
		});
		const existingOriginIds = new Set(
			current.rules.flatMap((rule) => (rule.originRuleId === undefined ? [] : [rule.originRuleId])),
		);
		const ruleIds = new Set(current.rules.map((rule) => rule.id));
		const importedRuleIds = new Set<string>();
		const importedRules: CommandGuardRule[] = [];
		const results = packs.map((pack) => {
			let importedCount = 0;
			let skippedCount = 0;
			for (const rule of pack.rules) {
				if (existingOriginIds.has(rule.originRuleId)) {
					skippedCount += 1;
					continue;
				}
				existingOriginIds.add(rule.originRuleId);
				const id = this.nextRuleId(ruleIds, importedRuleIds);
				importedRuleIds.add(id);
				importedRules.push({
					id,
					displayName: rule.displayName,
					pattern: rule.pattern,
					match: rule.match,
					...(rule.reason === undefined ? {} : { reason: rule.reason }),
					enabled: rule.enabled,
					source: "builtin",
					originRuleId: rule.originRuleId,
					packId: pack.id,
					packVersion: pack.version,
					level: rule.level,
				});
				importedCount += 1;
			}
			return { packId: pack.id, importedCount, skippedCount };
		});

		if (importedRules.length === 0) return { guard: current, results };
		const updated: Guard = {
			...current,
			enabled: true,
			rules: [...current.rules, ...importedRules],
			revision: current.revision + 1,
			updatedAt: this.clock.now(),
		};
		if (!(await this.guards.update(updated, input.expectedRevision))) {
			throw new ManagementError("revision_conflict", "Guard was modified by another request");
		}
		return { guard: updated, results };
	}

	private nextRuleId(existingRuleIds: ReadonlySet<string>, submittedRuleIds: ReadonlySet<string>): string {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const id = requireNonEmpty(this.ids.next(), "rules.id", 128);
			if (!existingRuleIds.has(id) && !submittedRuleIds.has(id)) return id;
		}
		throw new Error("Guard rule ID generator produced too many collisions");
	}
}

function sourceMetadata(
	rule: CommandGuardRule,
): Pick<CommandGuardRule, "source" | "originRuleId" | "packId" | "packVersion" | "level"> {
	return {
		source: rule.source,
		...(rule.originRuleId === undefined ? {} : { originRuleId: rule.originRuleId }),
		...(rule.packId === undefined ? {} : { packId: rule.packId }),
		...(rule.packVersion === undefined ? {} : { packVersion: rule.packVersion }),
		level: rule.level,
	};
}
