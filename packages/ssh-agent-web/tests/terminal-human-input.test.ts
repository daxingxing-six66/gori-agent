import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalHumanInput } from "../features/terminal/runtime/terminal-human-input";
import { registerTerminalSubmission, withTerminalSubmission } from "../features/terminal/runtime/terminal-submission-gate";
import type { TerminalInputControl } from "../features/terminal/model/terminal";
import { deferred } from "./helpers/hook-driver";

const controls: TerminalHumanInput[] = [];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { for (const control of controls.splice(0)) control.close(); vi.useRealTimers(); });
function fixture() {
	let epoch = 1;
	const state = vi.fn(), error = vi.fn();
	const write = vi.fn(async (_epoch: number, sequence: number, _bytes: Uint8Array) => ({ acceptedSequence: sequence }));
	const claim = vi.fn(async (focused: boolean): Promise<TerminalInputControl> => ({ mode: focused ? "human" : "idle",
		attachmentId: focused ? "a" : null, agentRunId: null, epoch: ++epoch }));
	const input = new TerminalHumanInput({ attachmentId: "a", control: { mode: "human", attachmentId: "a", agentRunId: null, epoch },
		claim, write, onState: state, onError: error });
	controls.push(input); return { input, write, claim, state, error };
}

describe("browser human terminal input", () => {
	it("treats a cleanup-time claim conflict as temporarily busy and retries on the next focus gesture", async () => {
		const f = fixture();
		f.input.updateControl({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 2 });
		f.claim.mockRejectedValueOnce(Object.assign(new Error("cleanup pending"), { code: "session_has_active_chat_run" }));
		f.input.ready(); f.input.setFocused(true); await settle();
		expect(f.error).not.toHaveBeenCalled();
		f.claim.mockResolvedValueOnce({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 3 });
		f.input.setFocused(true); await settle();
		expect(f.state).toHaveBeenLastCalledWith("ready", true);
	});
	it("never sends snapshot/replay input and enables input only for a focused live owner", async () => {
		const f = fixture();
		f.input.setFocused(true); f.input.enqueue(Buffer.from("before-ready"));
		f.input.ready(); await settle();
		expect(f.state).toHaveBeenLastCalledWith("ready", true);
		f.input.enqueue(Buffer.from("中文\t\x1b[A\x03"));
		await f.input.prepare();
		expect(Buffer.from(f.write.mock.calls[0]![2]).toString()).toBe("中文\t\x1b[A\x03");
		expect(f.write).toHaveBeenCalledOnce();
		expect(f.state).toHaveBeenLastCalledWith("handoff", false);
	});

	it("splits paste into ordered bounded batches and drains before releasing input", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		const bytes = new TextEncoder().encode("含".repeat(30000));
		f.input.enqueue(bytes); await f.input.prepare();
		expect(f.write.mock.calls.map(call => call[1])).toEqual([1, 2, 3]);
		expect(f.write.mock.calls.every(call => call[2].length <= 32768)).toBe(true);
		expect(Buffer.concat(f.write.mock.calls.map(call => Buffer.from(call[2])))).toEqual(Buffer.from(bytes));
		expect(f.claim).toHaveBeenLastCalledWith(false);
		expect(f.claim.mock.invocationCallOrder.at(-1)).toBeGreaterThan(f.write.mock.invocationCallOrder.at(-1)!);
	});

	it("waits for the final acknowledgement before creating a Run and freezes new input immediately", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		const pending = deferred<{ acceptedSequence: number }>(); f.write.mockReturnValueOnce(pending.promise);
		f.input.enqueue(Buffer.from("last key"));
		const unregister = registerTerminalSubmission("s", f.input);
		const start = vi.fn(async () => "run");
		try {
			const submitting = withTerminalSubmission("s", start);
			f.input.enqueue(Buffer.from("must not send")); await settle();
			expect(start).not.toHaveBeenCalled();
			pending.resolve({ acceptedSequence: 1 }); await expect(submitting).resolves.toBe("run");
			expect(f.write).toHaveBeenCalledOnce();
			expect(start).toHaveBeenCalledOnce();
		} finally { unregister(); }
	});

	it("preserves failure and blocks submission after an uncertain write without retrying any bytes", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		f.write.mockRejectedValueOnce(new Error("response lost")); f.input.enqueue(Buffer.from("once"));
		await expect(f.input.prepare()).rejects.toThrow("response lost");
		f.input.resume(); f.input.enqueue(Buffer.from("later"));
		await expect(f.input.prepare()).rejects.toThrow("response lost");
		expect(f.error).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
	});

	it("disables input for Agent and other pages, ignores stale events, and reacquires after Agent completion", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		f.input.updateControl({ mode: "human", attachmentId: "b", agentRunId: null, epoch: 3 });
		f.input.enqueue(Buffer.from("other")); expect(f.state).toHaveBeenLastCalledWith("other", false);
		f.input.updateControl({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 });
		expect(f.state).toHaveBeenLastCalledWith("other", false);
		f.input.updateControl({ mode: "agent", attachmentId: null, agentRunId: "run", epoch: 4 });
		f.input.enqueue(Buffer.from("agent")); expect(f.state).toHaveBeenLastCalledWith("agent", false);
		f.claim.mockResolvedValueOnce({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 6 });
		f.input.updateControl({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 5 }); await settle();
		expect(f.state).toHaveBeenLastCalledWith("ready", true);
		expect(f.write).not.toHaveBeenCalled();
	});

	it("releases on blur and discards queued input when ownership is lost or the panel unmounts", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		f.input.setFocused(false); await settle(); expect(f.claim).toHaveBeenLastCalledWith(false);
		f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("pending"));
		f.input.updateControl({ mode: "agent", attachmentId: null, agentRunId: "run", epoch: 10 });
		await expect(f.input.prepare()).rejects.toThrow(/ownership changed/);
		expect(f.write).not.toHaveBeenCalled();
		const second = fixture(); second.input.ready(); second.input.setFocused(true); await settle();
		second.input.enqueue(Buffer.from("unmounted")); second.input.close();
		await second.input.prepare(); expect(second.write).not.toHaveBeenCalled();
	});

	it("rejects oversized queued paste without partial dispatch", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		f.input.enqueue(new Uint8Array(256 * 1024 + 1));
		await expect(f.input.prepare()).rejects.toThrow(/queue is full/);
		expect(f.write).not.toHaveBeenCalled();
	});
});
