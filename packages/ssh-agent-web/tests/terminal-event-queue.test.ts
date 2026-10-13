import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSseEnvelope } from "../features/terminal/model/terminal";
import { TERMINAL_UI_DEFAULTS } from "../features/terminal/model/terminal-ui-defaults";
import { TerminalEventQueue } from "../features/terminal/runtime/terminal-event-queue";

function event(sequence: number | null, type: string, data: Record<string, unknown> = {}): TerminalSseEnvelope {
	return { version: 1, terminalSessionId: "terminal", sequence, type, data,
		emittedAt: "2026-10-13T09:53:00.000Z" };
}

function output(sequence: number, bytes: Uint8Array | string): TerminalSseEnvelope {
	return event(sequence, "terminal.output", {
		bytesBase64: Buffer.from(bytes).toString("base64"),
	});
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((finish) => { resolve = finish; });
	return { promise, resolve };
}

const queues: TerminalEventQueue[] = [];
function setup(initialSequence = 0) {
	const writeOutput = vi.fn<(_: Uint8Array, sequence: number) => Promise<void>>().mockResolvedValue(undefined);
	const applyEvent = vi.fn<(_: TerminalSseEnvelope, sequence: number) => void | Promise<void>>();
	const onError = vi.fn();
	const queue = new TerminalEventQueue({ initialSequence, writeOutput, applyEvent, onError });
	queues.push(queue);
	return { queue, writeOutput, applyEvent, onError };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const queue of queues.splice(0)) queue.close(); vi.useRealTimers(); });

describe("Terminal mirror event queue", () => {
	it("renders thousands of tiny command redraw fragments together without changing ANSI or split UTF-8 bytes", async () => {
		const { queue, writeOutput, applyEvent, onError } = setup();
		const bytes = Buffer.from("\r\x1b[2K[arthas@1]$ 含video.merge容器=".repeat(60));
		for (let index = 0; index < bytes.length; index++) queue.push(output(index + 1, bytes.subarray(index, index + 1)));
		queue.push(event(null, "terminal.stream.ready", { replayedThroughSequence: bytes.length }));
		await vi.advanceTimersByTimeAsync(0);
		expect(onError).not.toHaveBeenCalled();
		expect(writeOutput).toHaveBeenCalledOnce();
		expect(Buffer.from(writeOutput.mock.calls[0]![0])).toEqual(bytes);
		expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "terminal.stream.ready" }), bytes.length);
	});

	it("keeps input, resize, observation and ready barriers between output writes", async () => {
		const { queue, writeOutput, applyEvent } = setup(10);
		const order: string[] = [];
		writeOutput.mockImplementation(async (bytes, sequence) => { order.push(`${Buffer.from(bytes)}:${sequence}`); });
		applyEvent.mockImplementation((envelope, sequence) => { order.push(`${envelope.type}:${sequence}`); });
		queue.push(output(11, "before"));
		queue.push(event(12, "terminal.input"));
		queue.push(output(13, "after input"));
		queue.push(event(14, "terminal.resized", { rows: 48, cols: 87 }));
		queue.push(output(15, "after resize"));
		queue.push(event(16, "terminal.observation.captured"));
		queue.push(event(null, "terminal.stream.ready", { replayedThroughSequence: 16 }));
		queue.push(output(17, "live"));
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["before:11", "terminal.input:11", "after input:13", "terminal.resized:13",
			"after resize:15", "terminal.observation.captured:15", "terminal.stream.ready:16", "live:17"]);
	});

	it("waits for parsed output before acknowledging replay and keeps receiving while a write is pending", async () => {
		const { queue, writeOutput, applyEvent } = setup();
		const writing = deferred();
		writeOutput.mockReturnValueOnce(writing.promise);
		queue.push(output(1, "first"));
		await vi.advanceTimersByTimeAsync(0);
		queue.push(output(2, "second"));
		queue.push(output(3, "third"));
		queue.push(event(null, "terminal.stream.ready", { replayedThroughSequence: 3 }));
		expect(applyEvent).not.toHaveBeenCalled();
		writing.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(writeOutput).toHaveBeenCalledTimes(2);
		expect(Buffer.from(writeOutput.mock.calls[1]![0]).toString()).toBe("secondthird");
		expect(applyEvent).toHaveBeenCalledWith(expect.anything(), 3);
	});

	it("bounds each output write while preserving the complete byte stream", async () => {
		const { queue, writeOutput, onError } = setup();
		const fragment = "x".repeat(1024);
		for (let sequence = 1; sequence <= 200; sequence++) queue.push(output(sequence, fragment));
		await vi.advanceTimersByTimeAsync(0);
		expect(onError).not.toHaveBeenCalled();
		expect(writeOutput.mock.calls.every(([bytes]) => bytes.length <= TERMINAL_UI_DEFAULTS.outputBatchBytes)).toBe(true);
		expect(Buffer.concat(writeOutput.mock.calls.map(([bytes]) => Buffer.from(bytes))).toString()).toBe(fragment.repeat(200));
	});

	it("ignores duplicate replay events and requests resync once on a sequence gap", async () => {
		const { queue, writeOutput, onError } = setup(4);
		queue.push(output(4, "old"));
		queue.push(output(5, "new"));
		queue.push(output(5, "duplicate"));
		await vi.advanceTimersByTimeAsync(0);
		expect(Buffer.from(writeOutput.mock.calls[0]![0]).toString()).toBe("new");
		queue.push(output(7, "gap"));
		queue.push(output(8, "ignored"));
		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]![0]).toMatchObject({ message: "Terminal event sequence gap" });
	});

	it.each(["events", "bytes"] as const)("requests a fresh snapshot when pending %s exceed the display limit", async (limit) => {
		const { queue, writeOutput, onError } = setup();
		const writing = deferred();
		writeOutput.mockReturnValueOnce(writing.promise);
		queue.push(output(1, "pending"));
		await vi.advanceTimersByTimeAsync(0);
		if (limit === "events") {
			for (let sequence = 2; sequence <= TERMINAL_UI_DEFAULTS.pendingEventLimit + 1; sequence++) queue.push(output(sequence, "x"));
		} else queue.push(output(2, "x".repeat(TERMINAL_UI_DEFAULTS.pendingOutputBytes)));
		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]![0]).toMatchObject({ message: "Terminal display backlog requires a new snapshot" });
		writing.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(writeOutput).toHaveBeenCalledOnce();
	});

	it("recovers from a stalled parser or replay acknowledgement without waiting for more output", async () => {
		const { queue, applyEvent, onError } = setup();
		const ready = deferred();
		applyEvent.mockReturnValueOnce(ready.promise);
		queue.push(event(null, "terminal.stream.ready", { replayedThroughSequence: 0 }));
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.eventProcessingTimeoutMs);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]![0]).toMatchObject({ message: "Terminal event processing timed out" });
		ready.resolve();
	});

	it("discards queued callbacks and late writes when the attachment is replaced", async () => {
		const { queue, writeOutput, applyEvent, onError } = setup();
		const writing = deferred();
		writeOutput.mockReturnValueOnce(writing.promise);
		queue.push(output(1, "first"));
		await vi.advanceTimersByTimeAsync(0);
		queue.push(event(2, "terminal.input"));
		queue.close();
		writing.resolve();
		await vi.runAllTimersAsync();
		expect(applyEvent).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});
});
