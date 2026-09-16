"use client";

import type { CSSProperties } from "react";
import { useIntl, type IntlShape } from "react-intl";
import type { ObservationMaskState } from "@/features/terminal/model/terminal-observation-mask";
import type { ObservationViewportRange } from "@/features/terminal/model/terminal-observation-range";
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";

const PARTICLES = Array.from({ length: 16 }, (_, index) => index);

export function TerminalObservationMask({
	state,
	range,
	capturedAt,
}: {
	state: ObservationMaskState | null;
	range: ObservationViewportRange | null;
	capturedAt: number | null;
}) {
	const intl = useIntl();
	if (state === null || range === null) return null;
	const status = observationStatus(intl, state, range);
	const timestamp = capturedAt === null
		? null
		: new Date(capturedAt).toLocaleTimeString(intl.locale, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	return (
		<>
			<div
				className={`terminal-observation-mask terminal-observation-mask-${state.phase}`}
				data-position={range.position}
				style={{
					"--terminal-observation-top": `${range.topPercent}%`,
					"--terminal-observation-height": `${range.heightPercent}%`,
					"--terminal-observation-delivered-ms": `${TERMINAL_UI_DEFAULTS.observationMaskDeliveredFadeMs}ms`,
					"--terminal-observation-finished-ms": `${TERMINAL_UI_DEFAULTS.observationMaskFinishedFadeMs}ms`,
					"--terminal-observation-aurora-ms": `${TERMINAL_UI_DEFAULTS.observationMaskAuroraCycleMs}ms`,
				} as CSSProperties}
				aria-hidden="true"
			>
				{range.position === "above" || range.position === "below" ? (
					<div className="terminal-observation-edge-status">
						<span />{status}
					</div>
				) : (
					<div className="terminal-observation-zone">
						<div className="terminal-observation-aurora" />
						<div className="terminal-observation-particles">
							{PARTICLES.map((particle) => <i key={particle} />)}
						</div>
						{range.showStartRail ? <div className="terminal-observation-rail terminal-observation-rail-start" /> : null}
						{range.showEndRail ? <div className="terminal-observation-rail terminal-observation-rail-end" /> : null}
						<div className="terminal-observation-label">
							<span className="terminal-observation-status-dot" />
							<strong>{status}</strong>
							{timestamp ? <small>snapshot · {timestamp}</small> : null}
						</div>
					</div>
				)}
			</div>
			<span className="sr-only" role="status">{announcement(intl, state)}</span>
		</>
	);
}

function observationStatus(intl: IntlShape, state: ObservationMaskState, range: ObservationViewportRange): string {
	return intl.formatMessage({ id: range.position === "above" ? "terminal.observation.above" : range.position === "below" ? "terminal.observation.below" : range.position === "covering" ? "terminal.observation.covering" : range.position === "snapshot" ? "terminal.observation.snapshot" : state.phase === "delivered" ? "terminal.observation.delivered" : state.phase === "finished" ? "terminal.observation.finished" : "terminal.observation.here" });
}

function announcement(intl: IntlShape, state: ObservationMaskState): string {
	return intl.formatMessage({ id: state.phase === "delivered" ? "terminal.observation.announcement.delivered" : state.phase === "processing" ? "terminal.observation.announcement.processing" : "terminal.observation.announcement.finished" });
}
