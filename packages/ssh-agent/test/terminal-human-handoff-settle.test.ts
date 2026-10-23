import { afterEach, describe, expect, it, vi } from "vitest";
import { settleHumanActivity } from "../src/application/terminal/terminal-human-handoff-settle.ts";
import type { TerminalSequencedEvent } from "../src/application/terminal/terminal-replay-ring.ts";

function eventSource() {
	const listeners = new Set<(event: TerminalSequencedEvent) => void>();
	return {
		listeners,
		subscribe(listener: (event: TerminalSequencedEvent) => void) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		output() {
			for (const listener of listeners) listener({ type: "terminal.output", sequence: 1, emittedAt: 0, bytes: Uint8Array.of(13) });
		},
		close() {
			for (const listener of listeners) listener({ type: "terminal.status", sequence: 2, emittedAt: 0,
				oldStatus: "active", newStatus: "closed", reason: "shell_exited" });
		},
	};
}

describe("human handoff echo settling", () => {
	afterEach(() => { vi.useRealTimers(); });

	it("waits for quiet after the last output and releases its subscription and timers", async () => {
		vi.useFakeTimers();
		const source = eventSource();
		let finished = false;
		const settling = settleHumanActivity(source).then(() => { finished = true; });
		await vi.advanceTimersByTimeAsync(100);
		source.output();
		await vi.advanceTimersByTimeAsync(149);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await settling;
		expect(source.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("caps continuous output at one second without sending input or stopping the program", async () => {
		vi.useFakeTimers();
		const source = eventSource();
		const settling = settleHumanActivity(source);
		for (let elapsed = 0; elapsed < 900; elapsed += 100) {
			await vi.advanceTimersByTimeAsync(100);
			source.output();
		}
		await vi.advanceTimersByTimeAsync(100);
		await settling;
		expect(source.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ends immediately on terminal closure and clears both timers", async () => {
		vi.useFakeTimers();
		const source = eventSource();
		const settling = settleHumanActivity(source);
		source.close();
		await settling;
		expect(source.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
