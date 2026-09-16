import type { GuardRule, GuardRuleDraft, UpdateGuardRuleInput } from "@/features/guard/model/guard";

export interface GuardRuleErrors {
	displayName?: "required";
	pattern?: "required" | "invalid_regex";
}

export interface GuardRulePayload {
	rules: UpdateGuardRuleInput[];
	submittedDrafts: GuardRuleDraft[];
	hasChanges: boolean;
}

export function toGuardRuleDrafts(rules: GuardRule[]): GuardRuleDraft[] {
	return rules.map((rule) => ({ ...rule, clientKey: rule.id }));
}

export function validateGuardRule(rule: Pick<GuardRuleDraft, "displayName" | "match" | "pattern">): GuardRuleErrors {
	const errors: GuardRuleErrors = {};
	if (!rule.displayName.trim()) errors.displayName = "required";
	if (!rule.pattern.trim()) {
		errors.pattern = "required";
	} else if (rule.match === "regex") {
		try {
			new RegExp(rule.pattern);
		} catch {
			errors.pattern = "invalid_regex";
		}
	}
	return errors;
}

export function hasGuardRuleErrors(errors: GuardRuleErrors): boolean {
	return errors.displayName !== undefined || errors.pattern !== undefined;
}

export function toGuardRuleInput(rule: Pick<GuardRuleDraft, "displayName" | "enabled" | "id" | "match" | "pattern" | "reason">): UpdateGuardRuleInput {
	return {
		...(rule.id === undefined ? {} : { id: rule.id }),
		displayName: rule.displayName.trim(),
		pattern: rule.pattern,
		match: rule.match,
		...(rule.reason?.trim() ? { reason: rule.reason.trim() } : {}),
		enabled: rule.enabled,
	};
}

function sameRule(left: UpdateGuardRuleInput, right: UpdateGuardRuleInput): boolean {
	return left.id === right.id
		&& left.displayName === right.displayName
		&& left.pattern === right.pattern
		&& left.match === right.match
		&& left.reason === right.reason
		&& left.enabled === right.enabled;
}

function sameRuleList(left: UpdateGuardRuleInput[], right: UpdateGuardRuleInput[]): boolean {
	return left.length === right.length && left.every((rule, index) => {
		const other = right[index];
		return other !== undefined && sameRule(rule, other);
	});
}

export function buildGuardRulePayload(drafts: GuardRuleDraft[], savedRules: GuardRule[]): GuardRulePayload {
	const savedById = new Map(savedRules.map((rule) => [rule.id, rule]));
	const submittedDrafts: GuardRuleDraft[] = [];
	const rules: UpdateGuardRuleInput[] = [];

	for (const draft of drafts) {
		const errors = validateGuardRule(draft);
		if (!hasGuardRuleErrors(errors)) {
			submittedDrafts.push(draft);
			rules.push(toGuardRuleInput(draft));
			continue;
		}
		if (draft.id === undefined) continue;
		const saved = savedById.get(draft.id);
		if (!saved) continue;
		const savedDraft = { ...saved, clientKey: draft.clientKey };
		submittedDrafts.push(savedDraft);
		rules.push(toGuardRuleInput(savedDraft));
	}

	return {
		rules,
		submittedDrafts,
		hasChanges: !sameRuleList(rules, savedRules.map(toGuardRuleInput)),
	};
}

export function reconcileGuardRules(
	currentDrafts: GuardRuleDraft[],
	submittedDrafts: GuardRuleDraft[],
	savedRules: GuardRule[],
	appendMissingClientKeys: ReadonlySet<string> = new Set(),
): GuardRuleDraft[] {
	const submittedByClientKey = new Map(submittedDrafts.map((rule) => [rule.clientKey, rule]));
	const savedByClientKey = new Map<string, GuardRuleDraft>();
	for (const [index, submitted] of submittedDrafts.entries()) {
		const saved = savedRules[index];
		if (saved) savedByClientKey.set(submitted.clientKey, { ...saved, clientKey: submitted.clientKey });
	}

	const reconciled = currentDrafts.map((current) => {
		const submitted = submittedByClientKey.get(current.clientKey);
		const saved = savedByClientKey.get(current.clientKey);
		if (!submitted || !saved) return current;
		if (sameRule(toGuardRuleInput(current), toGuardRuleInput(submitted))) return saved;
		return current.id === undefined ? { ...current, id: saved.id } : current;
	});
	const currentKeys = new Set(currentDrafts.map((rule) => rule.clientKey));
	for (const clientKey of appendMissingClientKeys) {
		if (currentKeys.has(clientKey)) continue;
		const saved = savedByClientKey.get(clientKey);
		if (saved) reconciled.push(saved);
	}
	return reconciled;
}

function ruleChangedFromBase(local: GuardRuleDraft, base: GuardRule): boolean {
	return !sameRule(toGuardRuleInput(local), toGuardRuleInput(base));
}

export function rebaseGuardRules(baseRules: GuardRule[], localDrafts: GuardRuleDraft[], latestRules: GuardRule[]): GuardRuleDraft[] {
	const baseById = new Map(baseRules.map((rule) => [rule.id, rule]));
	const localById = new Map(localDrafts.flatMap((rule) => rule.id === undefined ? [] : [[rule.id, rule] as const]));
	const rebased: GuardRuleDraft[] = [];

	for (const latest of latestRules) {
		const base = baseById.get(latest.id);
		const local = localById.get(latest.id);
		if (base && !local) continue;
		if (base && local && ruleChangedFromBase(local, base)) {
			rebased.push(local);
			continue;
		}
		rebased.push({ ...latest, clientKey: latest.id });
	}
	for (const local of localDrafts) {
		if (local.id === undefined) rebased.push(local);
	}
	return rebased;
}
