import type { GuardRulePackSummary } from "@/features/guard/model/guard";

export const guardRulePackPlaceholders = [
	{
		id: "linux-critical",
		recommended: true,
	},
	{
		id: "ssh-protection",
		recommended: true,
	},
	{
		id: "disk-protection",
		recommended: true,
	},
	{
		id: "network-protection",
		recommended: false,
	},
] as const;

export function defaultSelectedRulePackIds(packs: readonly GuardRulePackSummary[]): string[] {
	return packs
		.filter((pack) => pack.recommended && pack.availableRuleCount > 0)
		.map((pack) => pack.id);
}

export function selectedRuleCount(packs: readonly GuardRulePackSummary[], selectedIds: ReadonlySet<string>): number {
	return packs.reduce(
		(total, pack) => total + (selectedIds.has(pack.id) ? pack.availableRuleCount : 0),
		0,
	);
}
