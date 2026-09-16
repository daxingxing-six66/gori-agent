import type { TerminalSseEnvelope, TerminalTimelineEvent } from "@/features/terminal/model/terminal";

export type ObservationMaskPhase = "delivered" | "processing" | "finished";

export interface ObservationMaskState {
	observationId: string;
	phase: ObservationMaskPhase;
}

const OBSERVATION_EVENT_PHASES = {
	"terminal.observation.delivered": "delivered",
	"terminal.observation.processing": "processing",
	"terminal.observation.finished": "finished",
} as const satisfies Record<string, ObservationMaskPhase>;

export function reduceObservationMaskState(
	state: ObservationMaskState | null,
	event: TerminalSseEnvelope,
): ObservationMaskState | null {
	if (event.type === "terminal.resync_required") return null;
	if (event.type === "terminal.status" && isTerminalStatusFinal(event.data.newStatus)) return null;
	const phase = observationPhase(event.type);
	if (phase === null) return state;
	const observationId = observationMaskEventId(event);
	if (observationId === null) return state;
	if (phase === "finished") {
		return state?.observationId === observationId ? { observationId, phase } : state;
	}
	return { observationId, phase };
}

export function restoreObservationMaskState(
	events: readonly TerminalTimelineEvent[],
	terminalSessionId: string,
): ObservationMaskState | null {
	for (const event of events) {
		if (event.terminalSessionId !== terminalSessionId) continue;
		const phase = timelineObservationPhase(event.type);
		if (phase === null || event.observationId === null || event.observationId.length === 0) continue;
		return phase === "finished" ? null : { observationId: event.observationId, phase };
	}
	return null;
}

export function isObservationMaskStateEvent(event: TerminalSseEnvelope): boolean {
	return (
		(observationPhase(event.type) !== null && observationMaskEventId(event) !== null) ||
		event.type === "terminal.resync_required" ||
		(event.type === "terminal.status" && isTerminalStatusFinal(event.data.newStatus))
	);
}

export function observationMaskEventId(event: TerminalSseEnvelope): string | null {
	return typeof event.data.observationId === "string" && event.data.observationId.length > 0
		? event.data.observationId
		: null;
}

function observationPhase(type: string): ObservationMaskPhase | null {
	return OBSERVATION_EVENT_PHASES[type as keyof typeof OBSERVATION_EVENT_PHASES] ?? null;
}

function timelineObservationPhase(type: string): ObservationMaskPhase | null {
	if (type === "observation.delivered") return "delivered";
	if (type === "observation.processing") return "processing";
	if (type === "observation.finished") return "finished";
	return null;
}

function isTerminalStatusFinal(value: unknown): boolean {
	return value === "closed" || value === "failed" || value === "lost";
}
