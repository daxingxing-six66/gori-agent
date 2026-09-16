import { describe, expect, it } from "vitest";
import { TerminalReplayGapError, TerminalReplayRing } from "../src/application/terminal/terminal-replay-ring.ts";

describe("TerminalReplayRing", () => {
	it("keeps output and state frames in one contiguous sequence", () => {
		const ring = new TerminalReplayRing({ maxFrames: 8, maxOutputBytes: 32 });
		ring.append({ sequence: 1, type: "terminal.output", emittedAt: 1, bytes: new Uint8Array([1, 2]) });
		ring.append({
			sequence: 2,
			type: "terminal.resize_owner_changed",
			emittedAt: 2,
			ownerAttachmentId: "attachment-1",
			ownershipEpoch: 1,
		});
		ring.append({
			sequence: 3,
			type: "terminal.resized",
			emittedAt: 3,
			geometry: { rows: 40, cols: 132 },
			ownerAttachmentId: "attachment-1",
			ownershipEpoch: 1,
		});

		expect(ring.replayAfter(1).events.map((event) => event.sequence)).toEqual([2, 3]);
		expect(() =>
			ring.append({ sequence: 5, type: "terminal.output", emittedAt: 5, bytes: new Uint8Array([5]) }),
		).toThrow("Terminal event sequence must be contiguous");
	});

	it("evicts by byte or frame limit and reports a replay gap", () => {
		const ring = new TerminalReplayRing({ maxFrames: 2, maxOutputBytes: 4 });
		ring.append({ sequence: 10, type: "terminal.output", emittedAt: 1, bytes: new Uint8Array([1, 2, 3]) });
		ring.append({ sequence: 11, type: "terminal.output", emittedAt: 2, bytes: new Uint8Array([4, 5, 6]) });
		ring.append({
			sequence: 12,
			type: "terminal.status",
			emittedAt: 3,
			oldStatus: "active",
			newStatus: "closing",
			reason: "idle_timeout",
		});

		expect(ring.frameCount).toBe(2);
		expect(ring.outputBytes).toBe(3);
		expect(() => ring.replayAfter(9)).toThrowError(TerminalReplayGapError);
		expect(ring.replayAfter(10).events.map((event) => event.sequence)).toEqual([11, 12]);
	});
});
