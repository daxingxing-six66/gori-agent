import { describe, expect, it } from "vitest";
import type { GuardRule, GuardRuleDraft } from "../features/guard/model/guard.ts";
import {
	buildGuardRulePayload,
	rebaseGuardRules,
	reconcileGuardRules,
	validateGuardRule,
} from "../features/guard/model/guard-editor-state.ts";

const savedRules: GuardRule[] = [
	{
		id: "rule-1",
		displayName: "禁止关机",
		pattern: "shutdown",
		match: "contains",
		reason: "保持服务在线",
		enabled: true,
	},
];

describe("Guard editor state", () => {
	it("keeps the last saved value when an existing draft is temporarily invalid", () => {
		const drafts: GuardRuleDraft[] = [{ ...savedRules[0]!, clientKey: "rule-1", pattern: "" }];
		const payload = buildGuardRulePayload(drafts, savedRules);
		expect(payload.rules).toEqual(savedRules);
		expect(payload.hasChanges).toBe(false);
	});

	it("omits incomplete new rules and submits valid new rules without an id", () => {
		const incomplete: GuardRuleDraft = {
			clientKey: "new-incomplete",
			displayName: "",
			pattern: "",
			match: "contains",
			enabled: true,
		};
		const complete: GuardRuleDraft = {
			clientKey: "new-complete",
			displayName: "禁止重启",
			pattern: "reboot",
			match: "starts_with",
			enabled: true,
		};
		const payload = buildGuardRulePayload([
			{ ...savedRules[0]!, clientKey: "rule-1" },
			incomplete,
			complete,
		], savedRules);
		expect(payload.rules).toHaveLength(2);
		expect(payload.rules[1]).toEqual({
			displayName: "禁止重启",
			pattern: "reboot",
			match: "starts_with",
			enabled: true,
		});
		expect(payload.hasChanges).toBe(true);
	});

	it("preserves edits made after a request while accepting the generated id", () => {
		const submitted: GuardRuleDraft = {
			clientKey: "new-rule",
			displayName: "禁止重启",
			pattern: "reboot",
			match: "contains",
			enabled: true,
		};
		const current = { ...submitted, reason: "输入期间新增的说明" };
		const response: GuardRule[] = [{ ...submitted, id: "rule-2" }];
		expect(reconcileGuardRules([current], [submitted], response)).toEqual([{ ...current, id: "rule-2" }]);
	});

	it("rebases only local changes onto the latest server rules", () => {
		const local: GuardRuleDraft[] = [{ ...savedRules[0]!, clientKey: "rule-1", pattern: "poweroff" }];
		const latest: GuardRule[] = [
			{ ...savedRules[0]!, reason: "服务器更新的说明" },
			{ id: "rule-2", displayName: "禁止格式化", pattern: "mkfs", match: "contains", enabled: true },
		];
		const rebased = rebaseGuardRules(savedRules, local, latest);
		expect(rebased[0]).toMatchObject({ id: "rule-1", pattern: "poweroff" });
		expect(rebased[1]).toMatchObject({ id: "rule-2", pattern: "mkfs" });
	});

	it("validates required fields and regular expressions", () => {
		expect(validateGuardRule({ displayName: "", pattern: "", match: "contains" })).toEqual({
			displayName: "required",
			pattern: "required",
		});
		expect(validateGuardRule({ displayName: "正则", pattern: "[", match: "regex" }).pattern).toBe("invalid_regex");
	});
});
