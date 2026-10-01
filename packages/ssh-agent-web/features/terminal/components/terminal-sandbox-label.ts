import type { IntlShape } from "react-intl";
import type { TerminalSandboxFacts } from "@/features/terminal/model/terminal";

export function terminalSandboxLabel(intl: IntlShape, sandbox: TerminalSandboxFacts | null | undefined): string {
	if (!sandbox) return "";
	if (sandbox.mode === "workspace_write") return ` · Landlock ABI ${sandbox.abi} · ${sandbox.sandboxRoot}`;
	return "source" in sandbox
		? ` · ${intl.formatMessage({ id: "terminal.sandbox.fallbackLabel" })}`
		: ` · ${intl.formatMessage({ id: "terminal.fullAccess.name" })} · ${new Date(sandbox.approvedAt).toLocaleString()}`;
}
