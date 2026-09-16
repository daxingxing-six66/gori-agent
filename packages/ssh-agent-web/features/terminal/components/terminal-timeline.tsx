"use client";

import { useEffect, useState } from "react";
import { useIntl, type IntlShape } from "react-intl";
import { terminalApi } from "@/features/terminal/api/terminal-api";
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";
import type { TerminalTimelineEvent } from "@/features/terminal/model/terminal";

export function TerminalTimeline({ sessionId }: { sessionId: string }) {
	const intl = useIntl();
	const [events, setEvents] = useState<TerminalTimelineEvent[]>([]);
	useEffect(() => {
		let stopped = false;
		const refresh = () => {
			void terminalApi.listTimeline(sessionId, 12).then((next) => {
				if (!stopped) setEvents(next);
			}).catch(() => undefined);
		};
		refresh();
		const timer = setInterval(refresh, TERMINAL_UI_DEFAULTS.timelineRefreshMs);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [sessionId]);

	if (events.length === 0) return null;
	return (
		<div className="app-scrollbar flex max-h-[92px] flex-col gap-1 overflow-y-auto border-t border-[var(--terminal-line)] px-3 py-2">
			{events.map((event) => (
				<div key={event.id} className="flex items-center gap-2 text-[9px] leading-4 text-[var(--terminal-muted)]">
					<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${event.type === "observation.processing" ? "animate-pulse bg-[var(--terminal-accent)]" : "bg-[var(--terminal-line-strong)]"}`} />
					<span className="shrink-0 font-mono text-[var(--terminal-muted)]">{new Date(event.createdAt).toLocaleTimeString([], { hour12: false })}</span>
					<span className={event.type === "observation.processing" ? "text-[var(--terminal-accent)]" : "text-[var(--terminal-ink)]"}>{timelineLabel(intl, event.type)}</span>
				</div>
			))}
		</div>
	);
}

function timelineLabel(intl: IntlShape, type: string): string {
	switch (type) {
		case "terminal.input": return intl.formatMessage({ id: "terminal.timeline.input" });
		case "observation.captured": return intl.formatMessage({ id: "terminal.timeline.captured" });
		case "observation.delivered": return intl.formatMessage({ id: "terminal.timeline.delivered" });
		case "observation.processing": return intl.formatMessage({ id: "terminal.timeline.processing" });
		case "observation.finished": return intl.formatMessage({ id: "terminal.timeline.finished" });
		case "terminal.opening": return intl.formatMessage({ id: "terminal.timeline.opening" });
		case "terminal.active": return intl.formatMessage({ id: "terminal.timeline.active" });
		case "terminal.closing": return intl.formatMessage({ id: "terminal.timeline.closing" });
		case "terminal.closed": return intl.formatMessage({ id: "terminal.timeline.closed" });
		case "terminal.lost": return intl.formatMessage({ id: "terminal.timeline.lost" });
		case "terminal.failed": return intl.formatMessage({ id: "terminal.timeline.failed" });
		default: return type;
	}
}
