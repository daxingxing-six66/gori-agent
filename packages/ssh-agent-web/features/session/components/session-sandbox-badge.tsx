"use client";

import { Shield, ShieldOff } from "lucide-react";
import { useIntl } from "react-intl";

export function SessionSandboxBadge({ enabled }: { enabled: boolean }) {
	const intl = useIntl();
	const Icon = enabled ? Shield : ShieldOff;
	const label = intl.formatMessage({ id: enabled ? "session.sandbox.on" : "session.sandbox.off" });
	return (
		<span
			role="status"
			className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ${enabled ? "bg-success-soft text-accent" : "bg-surface-muted text-secondary"}`}
		>
			<Icon size={13} aria-hidden="true" />
			{label}
		</span>
	);
}
