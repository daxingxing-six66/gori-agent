import type { IntlShape } from "react-intl";
import type { TerminalSandboxFacts } from "@/features/terminal/model/terminal";

export function terminalSandboxLabel(intl: IntlShape, sandbox: TerminalSandboxFacts | null | undefined): string {
	if (!sandbox) return "";
	if (sandbox.mode === "workspace_write") return sandbox.backend === "landlock"
		? ` · Landlock ABI ${sandbox.abi} · ${sandbox.sandboxRoot}`
		: ` · Bubblewrap ${sandbox.bubblewrapVersion} · ${sandbox.sandboxRoot}`;
	return "source" in sandbox
		? ` · ${intl.formatMessage({ id: sandbox.source === "session_setting" ? "session.sandbox.off" : "terminal.sandbox.fallbackLabel" })}`
		: ` · ${intl.formatMessage({ id: "terminal.fullAccess.name" })} · ${new Date(sandbox.approvedAt).toLocaleString()}`;
}
