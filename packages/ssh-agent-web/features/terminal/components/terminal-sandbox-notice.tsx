"use client";

import { useIntl } from "react-intl";
import type { TerminalSandboxFacts } from "@/features/terminal/model/terminal";

export function TerminalSandboxNotice({ sandbox }: { sandbox: TerminalSandboxFacts | null | undefined }) {
	const intl = useIntl();
	if (sandbox?.mode !== "full_access" || !("source" in sandbox)) return null;
	return <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-900">
		{intl.formatMessage({ id: sandbox.source === "session_setting" ? "session.sandbox.disabledDescription" : "terminal.sandbox.fallbackNotice" })}
	</div>;
}
