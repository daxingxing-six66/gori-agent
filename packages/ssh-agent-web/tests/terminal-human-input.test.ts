import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalHumanInput } from "../features/terminal/runtime/terminal-human-input";
import { TerminalEventQueue } from "../features/terminal/runtime/terminal-event-queue";
import { registerTerminalSubmission, withTerminalSubmission } from "../features/terminal/runtime/terminal-submission-gate";
import type { TerminalInputControl } from "../features/terminal/model/terminal";
import { deferred } from "./helpers/hook-driver";

const controls: TerminalHumanInput[] = [];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { for (const control of controls.splice(0)) control.close(); vi.useRealTimers(); });
function fixture(control: TerminalInputControl = { mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 },
	{ projectControlResponses = true }: { projectControlResponses?: boolean } = {}) {
	let epoch = control.epoch;
	const state = vi.fn(), error = vi.fn();
	const write = vi.fn<(epoch: number, sequence: number, bytes: Uint8Array) => Promise<{ acceptedSequence: number }>>(
		async (_epoch, sequence) => ({ acceptedSequence: sequence }));
	const claim = vi.fn(async (focused: boolean): Promise<TerminalInputControl> => ({ mode: focused ? "human" : "idle",
		attachmentId: focused ? "a" : null, agentRunId: null, epoch: ++epoch }));
	const input = new TerminalHumanInput({ attachmentId: "a", control,
		claim: async (focused) => {
			const response = await claim(focused);
			// Most unit cases model an already-applied SSE; ordering cases drive it separately.
			if (projectControlResponses) input.updateControl(response);
			return response;
		}, write, onState: state, onError: error });
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
		await expect(second.input.prepare()).rejects.toThrow(/closed/); expect(second.write).not.toHaveBeenCalled();
	});

	it("blocks submission after disconnect closes an input whose write later fails", async () => {
		vi.useFakeTimers();
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		const acknowledgement = deferred<{ acceptedSequence: number }>(); f.write.mockReturnValueOnce(acknowledgement.promise);
		const unregister = registerTerminalSubmission("disconnected", f.input);
		try {
			f.input.enqueue(Buffer.from("possibly written")); await vi.advanceTimersByTimeAsync(16);
			f.input.close(); acknowledgement.reject(new Error("response lost")); await settle();
			const start = vi.fn(async () => "run");
			await expect(withTerminalSubmission("disconnected", start)).rejects.toThrow("response lost");
			expect(start).not.toHaveBeenCalled();
		} finally { unregister(); }
	});

	it("does not start a Run if the prepared input closes while awaiting its final acknowledgement", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		const acknowledgement = deferred<{ acceptedSequence: number }>(); f.write.mockReturnValueOnce(acknowledgement.promise);
		const unregister = registerTerminalSubmission("closing", f.input);
		try {
			f.input.enqueue(Buffer.from("last key"));
			const start = vi.fn(async () => "run"), submitting = withTerminalSubmission("closing", start);
			await settle(); f.input.close(); acknowledgement.resolve({ acceptedSequence: 1 });
			await expect(submitting).rejects.toThrow(/closed/); expect(start).not.toHaveBeenCalled();
		} finally { unregister(); }
	});

	it("buffers typing during a live focus claim and sends it once after ownership is confirmed", async () => {
		vi.useFakeTimers();
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle();
		f.input.enqueue(Buffer.from("ls")); await vi.advanceTimersByTimeAsync(32);
		expect(f.write).not.toHaveBeenCalled();
		claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 }); await settle();
		f.input.enqueue(Buffer.from("\r")); await f.input.prepare();
		expect(Buffer.concat(f.write.mock.calls.map(call => Buffer.from(call[2]))).toString()).toBe("ls\r");
		expect(f.error).not.toHaveBeenCalled();
	});

	it("keeps keys captured synchronously with focus when submission begins before the claim task", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); f.input.enqueue(Buffer.from("typed immediately"));
		const preparing = f.input.prepare(); await settle();
		expect(f.claim).toHaveBeenCalledWith(true); expect(f.write).not.toHaveBeenCalled();
		claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 }); await preparing;
		expect(Buffer.from(f.write.mock.calls[0]![2]).toString()).toBe("typed immediately");
	});

	it("drains claim-time typing before allowing a chat submission", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("last key"));
		const unregister = registerTerminalSubmission("claiming", f.input);
		try {
			const start = vi.fn(async () => "run"), submitting = withTerminalSubmission("claiming", start);
			await settle(); expect(start).not.toHaveBeenCalled();
			claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 });
			await expect(submitting).resolves.toBe("run");
			expect(Buffer.from(f.write.mock.calls[0]![2]).toString()).toBe("last key");
		} finally { unregister(); }
	});

	it("reports claim-time typing that cannot be delivered after blur and releases a late claim", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("pending"));
		f.input.setFocused(false); claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 }); await settle();
		expect(f.error).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled();
		expect(f.claim).toHaveBeenLastCalledWith(false);
		await expect(f.input.prepare()).rejects.toThrow();
	});

	it("reports a failed claim with buffered typing and never retries the bytes", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("pending"));
		claim.reject(new Error("claim rejected")); await settle();
		f.input.setFocused(true); await settle();
		expect(f.error).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled();
		await expect(f.input.prepare()).rejects.toThrow("claim rejected");
	});

	it("bounds the claim-time queue and does not deliver bytes after overflow", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle();
		f.input.enqueue(new Uint8Array(256 * 1024)); f.input.enqueue(new Uint8Array(1));
		claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 }); await settle();
		expect(f.error).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled();
		await expect(f.input.prepare()).rejects.toThrow(/queue is full/);
	});

	it("does not buffer or send keys while busy or while the incoming control state is unapplied", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		f.input.setBusy(true); f.input.ready(); f.input.setFocused(true); f.input.enqueue(Buffer.from("busy")); await settle();
		expect(f.claim).not.toHaveBeenCalled();
		f.input.revokeControl({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 2 });
		f.input.setBusy(false); f.input.enqueue(Buffer.from("unapplied")); await settle();
		expect(f.claim).not.toHaveBeenCalled();
		f.input.updateControl({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 2 });
		f.claim.mockResolvedValueOnce({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 3 });
		f.input.setFocused(true); await settle(); await f.input.prepare();
		expect(f.write).not.toHaveBeenCalled();
	});

	it("immediately stops a claim-time queue on Agent revocation and ignores a late old claim", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("pending"));
		const agent: TerminalInputControl = { mode: "agent", attachmentId: null, agentRunId: "r", epoch: 2 };
		f.input.revokeControl(agent); f.input.updateControl(agent);
		claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 }); await settle();
		expect(f.error).toHaveBeenCalledOnce(); expect(f.write).not.toHaveBeenCalled();
		await expect(f.input.prepare()).rejects.toThrow(/ownership changed/);
	});

	it("does not wait for a duplicate control event that the display queue will discard", async () => {
		const idle: TerminalInputControl = { mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 };
		const f = fixture(idle); f.input.ready(); f.input.revokeControl(idle); f.input.setFocused(true); await settle();
		expect(f.state).toHaveBeenLastCalledWith("ready", true);
	});

	it("does not let an old claim response bypass a newer pending Agent revocation", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 }, { projectControlResponses: false });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle();
		const agent: TerminalInputControl = { mode: "agent", attachmentId: null, agentRunId: "r", epoch: 2 };
		f.input.revokeControl(agent); claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 }); await settle();
		f.input.enqueue(Buffer.from("must not send"));
		expect(f.state).toHaveBeenLastCalledWith("agent", false); expect(f.write).not.toHaveBeenCalled();
		f.input.updateControl(agent); await settle(); expect(f.error).not.toHaveBeenCalled();
	});

	it("keeps a newer HTTP grant behind the pending display boundary until its ordered event is applied", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 }, { projectControlResponses: false });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle();
		const idle: TerminalInputControl = { mode: "idle", attachmentId: null, agentRunId: null, epoch: 1 };
		const granted: TerminalInputControl = { mode: "human", attachmentId: "a", agentRunId: null, epoch: 2 };
		f.input.revokeControl(idle); claim.resolve(granted); await settle();
		expect(f.state).toHaveBeenLastCalledWith("handoff", false);
		f.input.updateControl(idle); await settle(); expect(f.state).toHaveBeenLastCalledWith("handoff", false);
		f.input.updateControl(granted); await settle(); expect(f.state).toHaveBeenLastCalledWith("ready", true);
	});

	it("finishes an already issued claim after becoming busy and drains captured keys before prepare", async () => {
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		f.input.ready(); f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("before busy"));
		f.input.setBusy(true); f.input.enqueue(Buffer.from("after busy"));
		const preparing = f.input.prepare(); claim.resolve({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 });
		await preparing;
		expect(Buffer.concat(f.write.mock.calls.map(call => Buffer.from(call[2]))).toString()).toBe("before busy");
		expect(f.claim).toHaveBeenLastCalledWith(false);
	});

	it("waits for ordered release display even when its HTTP acknowledgement arrives first", async () => {
		const f = fixture(undefined, { projectControlResponses: false }); f.input.ready(); f.input.setFocused(true); await settle();
		const release = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(release.promise);
		let finished = false; const preparing = f.input.prepare().then(() => { finished = true; }); await settle();
		const idle: TerminalInputControl = { mode: "idle", attachmentId: null, agentRunId: null, epoch: 2 };
		f.input.revokeControl(idle); release.resolve(idle); await settle(); expect(finished).toBe(false);
		f.input.updateControl(idle); await preparing; expect(finished).toBe(true);
	});

	it("rejects a prepared submission when closing an input that is waiting for control display", async () => {
		const f = fixture(undefined, { projectControlResponses: false }); f.input.ready(); f.input.setFocused(true); await settle();
		const release = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(release.promise);
		const preparing = f.input.prepare(); await settle();
		const idle: TerminalInputControl = { mode: "idle", attachmentId: null, agentRunId: null, epoch: 2 };
		f.input.revokeControl(idle); release.resolve(idle); await settle();
		f.input.close(); await expect(preparing).rejects.toThrow(/closed/);
	});

	it("unblocks a control display wait when an earlier in-flight write fails", async () => {
		vi.useFakeTimers();
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		const acknowledgement = deferred<{ acceptedSequence: number }>(); f.write.mockReturnValueOnce(acknowledgement.promise);
		f.input.enqueue(Buffer.from("uncertain")); await vi.advanceTimersByTimeAsync(16);
		f.input.revokeControl({ mode: "agent", attachmentId: null, agentRunId: "r", epoch: 2 });
		const preparing = f.input.prepare(); await settle();
		acknowledgement.reject(new Error("write failed while waiting for display"));
		await expect(preparing).rejects.toThrow("write failed while waiting for display");
	});

	it("waits for preceding terminal output before restoring input from a control event", async () => {
		vi.useFakeTimers();
		const f = fixture({ mode: "agent", attachmentId: null, agentRunId: "run", epoch: 1 });
		f.input.ready(); f.input.setFocused(true); await settle();
		const output = deferred<void>(); let displayed = false;
		const queue = new TerminalEventQueue({ initialSequence: 0,
			writeOutput: async () => { await output.promise; displayed = true; },
			applyEvent: () => { f.input.updateControl({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 2 }); },
			onError: f.error });
		try {
			queue.push({ version: 1, terminalSessionId: "t", type: "terminal.output", sequence: 1,
				emittedAt: new Date().toISOString(), data: { bytesBase64: btoa("last Agent output") } });
			await vi.advanceTimersByTimeAsync(0);
			f.input.revokeControl({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 2 });
			queue.push({ version: 1, terminalSessionId: "t", type: "terminal.control_changed", sequence: 2,
				emittedAt: new Date().toISOString(), data: {} });
			await settle(); expect(f.claim).not.toHaveBeenCalled(); expect(displayed).toBe(false);
			output.resolve(); await settle();
			expect(displayed).toBe(true); expect(f.state).toHaveBeenLastCalledWith("ready", true);
		} finally { queue.close(); }
	});

	it("buffers an ordinary focus claim until its grant is displayed after preceding idle output", async () => {
		vi.useFakeTimers();
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 }, { projectControlResponses: false });
		const claim = deferred<TerminalInputControl>(); f.claim.mockReturnValueOnce(claim.promise);
		const output = deferred<void>(); let displayed = false;
		const grant: TerminalInputControl = { mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 };
		const queue = new TerminalEventQueue({ initialSequence: 0,
			writeOutput: async () => { await output.promise; displayed = true; },
			applyEvent: () => { f.input.updateControl(grant); }, onError: f.error });
		try {
			queue.push({ version: 1, terminalSessionId: "t", type: "terminal.output", sequence: 1,
				emittedAt: new Date().toISOString(), data: { bytesBase64: btoa("background output") } });
			await vi.advanceTimersByTimeAsync(0);
			f.input.ready(); f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("before HTTP"));
			claim.resolve(grant); await settle(); f.input.enqueue(Buffer.from(" after HTTP"));
			f.input.revokeControl(grant);
			queue.push({ version: 1, terminalSessionId: "t", type: "terminal.control_changed", sequence: 2,
				emittedAt: new Date().toISOString(), data: {} });
			await settle(); expect(displayed).toBe(false); expect(f.write).not.toHaveBeenCalled();
			expect(f.state).toHaveBeenLastCalledWith("handoff", true);
			output.resolve(); await settle();
			expect(displayed).toBe(true);
			expect(Buffer.concat(f.write.mock.calls.map(call => Buffer.from(call[2]))).toString()).toBe("before HTTP after HTTP");
			expect(f.state).toHaveBeenLastCalledWith("ready", true);
		} finally { queue.close(); }
	});

	it("faults after ten seconds when HTTP confirmed a claim but its control projection never arrives", async () => {
		vi.useFakeTimers();
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 }, { projectControlResponses: false });
		f.input.ready(); f.input.setFocused(true); await settle(); f.input.enqueue(Buffer.from("must not replay"));
		const unregister = registerTerminalSubmission("missing-projection", f.input);
		const start = vi.fn(async () => "run"); let failure: unknown;
		const submitting = withTerminalSubmission("missing-projection", start).catch(error => { failure = error; });
		try {
			await vi.advanceTimersByTimeAsync(9_999);
			expect(f.error).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(f.error).toHaveBeenCalledOnce(); await submitting;
			expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toMatch(/synchronization timed out/);
			expect(start).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
			f.input.updateControl({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 });
			f.input.resume(); f.input.enqueue(Buffer.from("later")); await settle();
			expect(f.write).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
		} finally { unregister(); }
	});

	it("cancels the control projection deadline after normal synchronization", async () => {
		vi.useFakeTimers();
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 }, { projectControlResponses: false });
		f.input.ready(); f.input.setFocused(true); await settle(); expect(vi.getTimerCount()).toBe(1);
		f.input.updateControl({ mode: "human", attachmentId: "a", agentRunId: null, epoch: 1 }); await settle();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10_000); expect(f.error).not.toHaveBeenCalled();
	});

	it("cancels the control projection deadline and rejects its waiter on close", async () => {
		vi.useFakeTimers();
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 }, { projectControlResponses: false });
		f.input.ready(); f.input.setFocused(true); await settle(); expect(vi.getTimerCount()).toBe(1);
		const preparing = f.input.prepare();
		f.input.close(); await expect(preparing).rejects.toThrow(/closed/);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10_000); expect(f.error).not.toHaveBeenCalled();
	});

	it("cancels the control projection deadline when another input fault stops the queue", async () => {
		vi.useFakeTimers();
		const f = fixture({ mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 }, { projectControlResponses: false });
		f.input.ready(); f.input.setFocused(true); await settle(); expect(vi.getTimerCount()).toBe(1);
		f.input.enqueue(new Uint8Array(256 * 1024 + 1)); await settle();
		await expect(f.input.prepare()).rejects.toThrow(/queue is full/);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10_000); expect(f.error).toHaveBeenCalledOnce();
	});

	it("rejects oversized queued paste without partial dispatch", async () => {
		const f = fixture(); f.input.ready(); f.input.setFocused(true); await settle();
		f.input.enqueue(new Uint8Array(256 * 1024 + 1));
		await expect(f.input.prepare()).rejects.toThrow(/queue is full/);
		expect(f.write).not.toHaveBeenCalled();
	});
});
