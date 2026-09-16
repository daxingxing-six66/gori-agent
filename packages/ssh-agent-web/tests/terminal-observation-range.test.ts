import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
	findObservationBufferRange,
	hasMeaningfulObservationText,
	observationFinishedDelay,
	ObservationSequenceCheckpoints,
	projectObservationViewportRange,
	snapshotObservationViewportRange,
} from "../features/terminal/model/terminal-observation-range.ts";
import { TerminalObservationRangeTracker } from "../features/terminal/runtime/terminal-observation-range-tracker.ts";

class FakeMarker {
	isDisposed = false;

	constructor(readonly line: number) {}

	dispose(): void {
		this.isDisposed = true;
	}
}

describe("Terminal Observation sequence checkpoints", () => {
	it("resolves the latest marker at or before an Observation sequence", () => {
		const checkpoints = new ObservationSequenceCheckpoints(60_000, 4);
		checkpoints.record(4, 100, new FakeMarker(10));
		checkpoints.record(7, 200, new FakeMarker(13));
		expect(checkpoints.lineAtOrBefore(3)).toBeNull();
		expect(checkpoints.lineAtOrBefore(4)).toBe(10);
		expect(checkpoints.lineAtOrBefore(6)).toBe(10);
		expect(checkpoints.lineAtOrBefore(7)).toBe(13);
	});

	it("disposes markers removed by capacity, retention, and tracker cleanup", () => {
		const checkpoints = new ObservationSequenceCheckpoints(100, 2);
		const first = new FakeMarker(1);
		const second = new FakeMarker(2);
		const third = new FakeMarker(3);
		checkpoints.record(1, 0, first);
		checkpoints.record(2, 10, second);
		checkpoints.record(3, 20, third);
		expect(first.isDisposed).toBe(true);
		checkpoints.prune(200);
		expect(second.isDisposed).toBe(true);
		checkpoints.dispose();
		expect(third.isDisposed).toBe(true);
	});
});

describe("Terminal Observation viewport projection", () => {
	it("projects complete and clipped ranges without moving their semantic boundaries", () => {
		expect(projectObservationViewportRange(12, 15, 10, 10)).toEqual({
			position: "visible",
			topPercent: 20,
			heightPercent: 40,
			showStartRail: true,
			showEndRail: true,
		});
		expect(projectObservationViewportRange(8, 15, 10, 10)).toMatchObject({
			position: "visible",
			topPercent: 0,
			heightPercent: 60,
			showStartRail: false,
			showEndRail: true,
		});
		expect(projectObservationViewportRange(8, 24, 10, 10)).toMatchObject({
			position: "covering",
			topPercent: 0,
			heightPercent: 100,
		});
	});

	it("reports ranges outside the viewport and the explicit snapshot fallback", () => {
		expect(projectObservationViewportRange(1, 5, 10, 10).position).toBe("above");
		expect(projectObservationViewportRange(20, 24, 10, 10).position).toBe("below");
		expect(snapshotObservationViewportRange()).toEqual({
			position: "snapshot",
			topPercent: 0,
			heightPercent: 100,
			showStartRail: true,
			showEndRail: true,
		});
	});
});

describe("Terminal Observation buffer recovery", () => {
	it("recovers physical start and end rows across wrapped lines", () => {
		expect(findObservationBufferRange([
			{ text: "prompt$ memory", isWrapped: false },
			{ text: "heap 28M ", isWrapped: false },
			{ text: "of 390M", isWrapped: true },
			{ text: "metaspace 57M", isWrapped: false },
			{ text: "prompt$", isWrapped: false },
		], "heap 28M of 390M\nmetaspace 57M")).toEqual({ startLine: 1, endLine: 3 });
	});

	it("removes the truncation notice but refuses a non-matching range", () => {
		const lines = [{ text: "latest output", isWrapped: false }];
		expect(findObservationBufferRange(lines, "[Earlier terminal output omitted]\nlatest output")).toEqual({
			startLine: 0,
			endLine: 0,
		});
		expect(findObservationBufferRange(lines, "different output")).toBeNull();
	});

	it("renders only Observations that contain meaningful Terminal text", () => {
		expect(hasMeaningfulObservationText("memory output")).toBe(true);
		expect(hasMeaningfulObservationText("  \n\t")).toBe(false);
		expect(hasMeaningfulObservationText("[Earlier terminal output omitted]\n")).toBe(false);
	});
});

describe("Terminal Observation minimum visibility", () => {
	it("delays fast completion but does not delay an already visible Observation", () => {
		expect(observationFinishedDelay(1_000, 1_100, 800)).toBe(700);
		expect(observationFinishedDelay(1_000, 1_900, 800)).toBe(0);
	});
});

describe("Terminal Observation xterm range tracker", () => {
	it("keeps strict input and captured markers anchored to the viewport", () => {
		const markers: FakeMarker[] = [];
		const active = {
			type: "normal" as const,
			cursorY: 5,
			cursorX: 0,
			viewportY: 10,
			baseY: 10,
			length: 30,
			getLine: () => undefined,
			getNullCell: () => { throw new Error("unused"); },
		};
		const terminal = {
			rows: 10,
			buffer: { active },
			registerMarker: (offset = 0) => {
				const marker = new FakeMarker(active.baseY + active.cursorY + offset);
				markers.push(marker);
				return marker;
			},
		} as unknown as Terminal;
		const tracker = new TerminalObservationRangeTracker(terminal);
		tracker.recordInput("interaction-1");
		active.cursorY = 8;
		tracker.recordCaptured("observation-1", "interaction-1", 1234);
		tracker.resolveObservation({
			id: "observation-1",
			terminalSessionId: "terminal-1",
			startSequence: 4,
			endSequence: 8,
			kind: "transcript",
			agentViewText: "memory output",
			capturedAt: 1234,
		});
		expect(tracker.presentation("observation-1")).toEqual({
			capturedAt: 1234,
			range: {
				position: "visible",
				topPercent: 50,
				heightPercent: 40,
				showStartRail: true,
				showEndRail: true,
			},
		});
		tracker.disposeObservation("observation-1");
		expect(markers.every((marker) => marker.isDisposed)).toBe(true);
	});

	it("suppresses the viewport presentation for an empty Observation", () => {
		const active = {
			type: "normal" as const,
			cursorY: 5,
			cursorX: 0,
			viewportY: 10,
			baseY: 10,
			length: 30,
			getLine: () => undefined,
			getNullCell: () => { throw new Error("unused"); },
		};
		const terminal = {
			rows: 10,
			buffer: { active },
			registerMarker: (offset = 0) => new FakeMarker(active.baseY + active.cursorY + offset),
		} as unknown as Terminal;
		const tracker = new TerminalObservationRangeTracker(terminal);
		tracker.recordInput("interaction-1");
		tracker.recordCaptured("observation-1", "interaction-1", 1234);
		tracker.resolveObservation({
			id: "observation-1",
			terminalSessionId: "terminal-1",
			startSequence: 4,
			endSequence: 4,
			kind: "transcript",
			agentViewText: " \n\t",
			capturedAt: 1234,
		});
		expect(tracker.presentation("observation-1")).toBeNull();
	});
});
