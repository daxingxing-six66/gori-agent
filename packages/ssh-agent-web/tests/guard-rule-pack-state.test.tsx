import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { GuardRulePackDialog } from "../features/guard/components/guard-rule-pack-dialog.tsx";
import {
	defaultSelectedRulePackIds,
	selectedRuleCount,
} from "../features/guard/model/guard-rule-pack-state.ts";
import type { GuardRulePackSummary } from "../features/guard/model/guard.ts";
import { zhCNMessages } from "../features/i18n/messages/zh-CN.ts";

const packs: GuardRulePackSummary[] = [
	{
		id: "linux-critical",
		name: "Linux 基础保护",
		description: "Linux",
		version: "1.0.0",
		ruleCount: 7,
		importedRuleCount: 2,
		availableRuleCount: 5,
		recommended: true,
	},
	{
		id: "ssh-protection",
		name: "SSH 防失联",
		description: "SSH",
		version: "1.0.0",
		ruleCount: 5,
		importedRuleCount: 5,
		availableRuleCount: 0,
		recommended: true,
	},
	{
		id: "network-protection",
		name: "网络连接保护",
		description: "Network",
		version: "1.0.0",
		ruleCount: 2,
		importedRuleCount: 0,
		availableRuleCount: 2,
		recommended: false,
	},
];

describe("Guard rule pack state", () => {
	it("selects only recommended packs that still contain missing rules", () => {
		expect(defaultSelectedRulePackIds(packs)).toEqual(["linux-critical"]);
	});

	it("counts only missing rules from selected packs", () => {
		expect(selectedRuleCount(packs, new Set(["linux-critical", "network-protection"]))).toBe(7);
	});

	it("keeps the preset catalog visible but disables import before the backend endpoint is ready", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, createElement(GuardRulePackDialog, {
			workspaceId: "workspace-1",
			onClose: () => undefined,
			onImport: () => Promise.reject(new Error("not called")),
		})));
		expect(html).toContain("Linux 基础保护");
		expect(html).toContain("网络连接保护");
		expect(html).toContain("规则目录尚未就绪");
		expect(html).toContain("disabled=\"\"");
	});
});
