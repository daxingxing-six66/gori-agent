import { describe, expect, it } from "vitest";
import type { TerminalSseEnvelope, TerminalTimelineEvent } from "../features/terminal/model/terminal.ts";
import {
	reduceObservationMaskState,
	restoreObservationMaskState,
} from "../features/terminal/model/terminal-observation-mask.ts";

function envelope(type: string, data: Record<string, unknown> = {}): TerminalSseEnvelope {
	return {
		version: 1,
		terminalSessionId: "terminal-1",
		type,
		sequence: 1,
		emittedAt: "2026-08-29T00:00:00.000Z",
		data,
	};
}

function timelineEvent(
	type: string,
	observationId: string | null,
	terminalSessionId = "terminal-1",
): TerminalTimelineEvent {
	return {
		id: `${terminalSessionId}-${type}`,
		terminalSessionId,
		sessionId: "session-1",
		timelineSequence: 1,
		terminalEventSequence: 1,
		type,
		interactionId: "interaction-1",
		observationId,
		agentRunId: "run-1",
		data: {},
		createdAt: 1,
	};
}

describe("Terminal Observation Mask state", () => {
	it("moves through delivered, processing, and finished", () => {
		let state = reduceObservationMaskState(null, envelope("terminal.observation.delivered", { observationId: "observation-1" }));
		expect(state).toEqual({ observationId: "observation-1", phase: "delivered" });
		state = reduceObservationMaskState(state, envelope("terminal.observation.processing", { observationId: "observation-1" }));
		expect(state).toEqual({ observationId: "observation-1", phase: "processing" });
		state = reduceObservationMaskState(state, envelope("terminal.observation.finished", { observationId: "observation-1" }));
		expect(state).toEqual({ observationId: "observation-1", phase: "finished" });
	});

	it("keeps a newer Observation when an older finished event arrives", () => {
		const newer = { observationId: "observation-2", phase: "processing" } as const;
		expect(reduceObservationMaskState(
			newer,
			envelope("terminal.observation.finished", { observationId: "observation-1" }),
		)).toEqual(newer);
	});

	it("replaces the current state when a new Observation is delivered", () => {
		expect(reduceObservationMaskState(
			{ observationId: "observation-1", phase: "processing" },
			envelope("terminal.observation.delivered", { observationId: "observation-2" }),
		)).toEqual({ observationId: "observation-2", phase: "delivered" });
	});

	it("ignores malformed events and clears stale state on resync or final status", () => {
		const active = { observationId: "observation-1", phase: "processing" } as const;
		expect(reduceObservationMaskState(active, envelope("terminal.observation.processing"))).toEqual(active);
		expect(reduceObservationMaskState(active, envelope("terminal.resync_required"))).toBeNull();
		expect(reduceObservationMaskState(active, envelope("terminal.status", { newStatus: "lost" }))).toBeNull();
	});
});

describe("Terminal Observation Mask timeline restore", () => {
	it("restores the latest active stage for the current TerminalSession", () => {
		const events = [
			timelineEvent("observation.processing", "other-observation", "terminal-2"),
			timelineEvent("observation.processing", "observation-1"),
			timelineEvent("observation.delivered", "observation-1"),
		];
		expect(restoreObservationMaskState(events, "terminal-1")).toEqual({
			observationId: "observation-1",
			phase: "processing",
		});
	});

	it("does not restore a finished, unrelated, malformed, or absent Observation", () => {
		expect(restoreObservationMaskState([
			timelineEvent("observation.finished", "observation-1"),
			timelineEvent("observation.processing", "observation-1"),
		], "terminal-1")).toBeNull();
		expect(restoreObservationMaskState([
			timelineEvent("observation.processing", "observation-2", "terminal-2"),
			timelineEvent("observation.processing", ""),
			timelineEvent("observation.processing", null),
		], "terminal-1")).toBeNull();
		expect(restoreObservationMaskState([], "terminal-1")).toBeNull();
	});
});
