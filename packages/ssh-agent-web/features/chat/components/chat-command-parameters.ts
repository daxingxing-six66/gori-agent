import type { IntlShape } from "react-intl";
import type { CommandParameter } from "./chat-command-details";

export function commandParameters(intl: IntlShape, args: Record<string, unknown>, omitted?: string): CommandParameter[] {
	return Object.entries(args).filter(([key, value]) => key !== omitted && value !== undefined)
		.map(([key, value]) => ({ label: parameterLabel(intl, key), value: parameterValue(intl, key, value) }));
}

function parameterLabel(intl: IntlShape, key: string): string {
	const labels = {
		cwd: "chat.tool.command.cwd", timeoutMs: "chat.tool.command.timeout",
		action: "chat.tool.command.action", expectation: "chat.tool.command.expectation",
		key: "chat.tool.command.shortcut", sandbox_permissions: "chat.tool.command.permissions",
		justification: "chat.tool.command.justification", write_paths: "chat.tool.command.writePaths",
	} as const;
	const id = labels[key as keyof typeof labels];
	return typeof id === "string" ? intl.formatMessage({ id }) : key;
}

function parameterValue(intl: IntlShape, key: string, value: unknown): string {
	if (key === "timeoutMs" && typeof value === "number" && Number.isFinite(value)) return `${intl.formatNumber(value)} ms`;
	const values = {
		action: { submit: "chat.tool.command.action.submit", key: "chat.tool.command.action.key", observe: "chat.tool.command.action.observe" },
		expectation: { finite: "chat.tool.command.expectation.finite", interactive: "chat.tool.command.expectation.interactive", streaming: "chat.tool.command.expectation.streaming" },
		sandbox_permissions: { workspace_write: "chat.tool.command.permissions.workspaceWrite", full_access: "chat.tool.command.permissions.fullAccess" },
	} as const;
	if (typeof value === "string") {
		if (key === "key" && value === "CTRL_C") return "Ctrl+C";
		const labels = Object.hasOwn(values, key) ? values[key as keyof typeof values] : undefined;
		const id = labels && Object.hasOwn(labels, value) ? labels[value as keyof typeof labels] : undefined;
		if (id) return intl.formatMessage({ id });
		return value;
	}
	if (key === "write_paths" && Array.isArray(value) && value.every((path) => typeof path === "string")) return value.join("\n");
	return JSON.stringify(value) ?? String(value);
}
