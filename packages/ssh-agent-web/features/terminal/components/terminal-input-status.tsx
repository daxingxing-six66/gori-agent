"use client";

import { ArrowRightLeft, Bot, Keyboard, LockKeyhole, PanelsTopLeft } from "lucide-react";
import { useIntl } from "react-intl";
import type { HumanInputPhase } from "@/features/terminal/runtime/terminal-human-input";

const phaseIcons = {
	ready: Keyboard,
	handoff: ArrowRightLeft,
	agent: Bot,
	other: PanelsTopLeft,
	unavailable: LockKeyhole,
} as const;

export function TerminalInputStatus({ phase }: { phase: HumanInputPhase }) {
	const intl = useIntl();
	const Icon = phaseIcons[phase];

	return (
		<div className="terminal-input-status" role="status" data-phase={phase}>
			<span className="terminal-input-status-badge">
				<span className="terminal-input-status-icon" aria-hidden="true">
					<Icon size={14} strokeWidth={1.8} />
				</span>
				<span>{intl.formatMessage({ id: `terminal.input.${phase}` })}</span>
			</span>
		</div>
	);
}
