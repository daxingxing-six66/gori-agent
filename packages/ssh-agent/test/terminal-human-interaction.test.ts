import { afterEach, describe, expect, it, vi } from "vitest";
import { humanFixture } from "./terminal-human-fixture.ts";
import { parseTerminalHumanInput } from "../src/api/terminal-request-validation.ts";
import { handleTerminalRoute } from "../src/api/terminal-routes.ts";
import { authorizationFailure } from "../src/application/tools/tool-authorization.ts";
import type { TerminalInteractionRequest } from "../src/application/terminal/terminal-interaction-policy.ts";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); });
async function fixture() { const result = await humanFixture(); close.push(result.cleanup); return result; }

describe("human and Agent terminal cooperation", () => {
	it("owns input separately from resize, rejects stale tabs and epochs, and deduplicates acknowledged bytes", async () => {
		const f = await fixture(), first = await f.attach(), second = await f.attach();
		const firstControl = await f.service.controlInput("s", first, true);
		await f.service.focus("s", second, true);
		const request = { terminalSessionId: f.terminal.id, controlEpoch: firstControl.epoch, inputSequence: 1, bytes: Buffer.from("中文\t\x1b[A\x03") };
		await f.service.writeHumanInput("s", first, request);
		await f.service.writeHumanInput("s", first, request);
		expect(f.channel.writes).toHaveLength(1);
		await expect(f.service.writeHumanInput("s", first, { ...request, inputSequence: 3 })).rejects.toMatchObject({ code: "terminal_input_out_of_order" });
		await expect(f.service.writeHumanInput("s", first, { ...request, bytes: Buffer.from("different") })).rejects.toMatchObject({ code: "terminal_input_out_of_order" });
		const secondControl = await f.service.controlInput("s", second, true);
		await expect(f.service.writeHumanInput("s", first, { ...request, inputSequence: 2 })).rejects.toMatchObject({ code: "terminal_control_conflict" });
		await expect(f.service.writeHumanInput("s", second, { ...request, controlEpoch: secondControl.epoch - 1 })).rejects.toMatchObject({ code: "terminal_control_conflict" });
		await f.service.detach("s", second);
		expect(f.actor.inputControl.mode).toBe("idle");
		expect(f.channel.writes).toHaveLength(1);
	});

	it("blocks manual input while Chat is initializing, before the Run reaches PTY binding", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		f.setBusy(true);
		await expect(f.service.controlInput("s", attachment, true)).rejects.toMatchObject({ code: "session_has_active_chat_run" });
		await expect(f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id,
			controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("blocked") })).rejects.toMatchObject({ code: "session_has_active_chat_run" });
		expect(f.channel.writes).toHaveLength(0);
		await f.service.controlInput("s", attachment, false);
		f.setBusy(false);
		expect((await f.service.controlInput("s", attachment, true)).mode).toBe("human");
	});

	it("bounds a stalled SSH write and destroys its channel without replay", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		f.channel.writeGate = new Promise<void>(() => undefined);
		vi.useFakeTimers();
		try {
			const request = f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id,
				controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("stalled") });
			const rejected = expect(request).rejects.toMatchObject({ code: "terminal_input_uncertain" });
			await vi.advanceTimersByTimeAsync(10001); await rejected;
			expect(f.channel.disposed).toBe(true);
			expect(f.channel.writes).toHaveLength(1);
			expect(f.repository.latestHumanActivity("s")?.writeStatus).toBe("uncertain");
		} finally { vi.useRealTimers(); }
	});

	it("serializes accepted human writes before Run binding and blocks all late human input", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		let release!: () => void;
		f.channel.writeGate = new Promise<void>(resolve => { release = resolve; });
		const input = { terminalSessionId: f.terminal.id, controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("top\r") };
		const writing = f.actor.writeHumanInput(attachment, input);
		const binding = f.service.bindRun("s", "run", "terminal");
		const late = f.actor.writeHumanInput(attachment, { ...input, inputSequence: 2 });
		const rejected = expect(late).rejects.toMatchObject({ code: "terminal_control_conflict" });
		release(); await writing; await binding; await rejected;
		expect(f.actor.inputControl).toMatchObject({ mode: "agent", agentRunId: "run" });
		expect(f.repository.latestHumanActivity("s")).toMatchObject({ endReason: "handoff", inputCount: 1 });
		expect(f.channel.writes).toHaveLength(1);
		await f.service.controlInput("s", attachment, true);
		expect(f.actor.inputControl.mode).toBe("agent");
		await f.service.unbindRun("s", "run");
		expect((await f.service.controlInput("s", attachment, true)).mode).toBe("human");
	});

	it("persists visible text, preserves the foreground screen, and never stores hidden input", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		f.channel.echo = false;
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("hidden-password-27\r") });
		f.channel.emit("visible result\r\n"); await f.actor.captureCanonical();
		f.channel.emit("\x1b[?1049h\x1b[2J\x1b[Hvim: unfinished edit"); await f.actor.captureCanonical();
		await f.service.bindRun("s", "run", "terminal");
		const activity = f.repository.latestHumanActivity("s")!;
		expect(activity.transcript).toContain("visible result");
		expect(activity.screenText).toContain("vim: unfinished edit");
		expect(activity.truncated).toBe(true);
		const persisted = JSON.stringify(f.db.prepare("SELECT * FROM terminal_human_activities").all());
		expect(persisted).not.toContain("hidden-password");
		expect(f.db.prepare("SELECT count(*) AS n FROM terminal_inputs").get()?.n).toBe(0);
		expect(f.channel.writes).toHaveLength(1);
	});

	it("requires a delivered observe before Agent submit or CTRL_C, while preserving the Observation cursor", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("echo HUMAN\r") });
		await f.actor.captureCanonical(); await f.service.bindRun("s", "run", "terminal");
		const request: TerminalInteractionRequest = { sessionId: "s", terminalSessionId: f.terminal.id, agentRunId: "run", toolCallId: "submit",
			action: { type: "submit", input: "echo AGENT" }, expectation: "streaming" };
		await expect(f.interactions.preflightSubmit(request, false)).rejects.toMatchObject({ code: "terminal_observe_required" });
		try { f.actor.requireAgentControl("run", true); } catch (error) { expect(authorizationFailure(error)).toMatchObject({ terminate: false }); }
		await expect(Promise.resolve().then(() => f.interactions.execute({ ...request, toolCallId: "key", action: { type: "key", key: "CTRL_C" } })))
			.rejects.toMatchObject({ code: "terminal_observe_required" });
		const observed = await f.interactions.execute({ ...request, toolCallId: "observe", action: { type: "observe" } });
		expect(observed.observation.agentViewText).toContain("HUMAN");
		await expect(f.interactions.preflightSubmit(request, false)).rejects.toMatchObject({ code: "terminal_observe_required" });
		await f.interactions.markDelivered(observed);
		await f.interactions.preflightSubmit(request, false);
		await f.interactions.execute(request);
		expect(f.channel.writes.map(bytes => Buffer.from(bytes).toString())).toEqual(["echo HUMAN\r", "echo AGENT\r"]);
	});

	it("does not bind a Run when handoff persistence fails, and retries the durable checkpoint", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("pending") });
		vi.spyOn(f.repository, "saveHumanActivity").mockImplementationOnce(() => { throw new Error("disk full"); });
		await expect(f.service.bindRun("s", "run", "terminal")).rejects.toThrow("disk full");
		expect(f.actor.inputControl.mode).toBe("idle");
		await f.service.bindRun("s", "run", "terminal");
		expect(f.repository.latestHumanActivity("s")?.endReason).toBe("handoff");
	});

	it("releases all Run ownership when the final binding persistence fails", async () => {
		const f = await fixture(), attachment = await f.attach();
		await f.service.controlInput("s", attachment, true);
		const updateSession = f.repository.updateSession.bind(f.repository);
		let writes = 0;
		vi.spyOn(f.repository, "updateSession").mockImplementation((...args) => {
			if (++writes === 2) throw new Error("binding activity persistence failed");
			return updateSession(...args);
		});

		await expect(f.service.bindRun("s", "run", "terminal")).rejects.toThrow("binding activity persistence failed");
		expect(f.actor.inputControl.mode).toBe("idle");
		expect((await f.service.controlInput("s", attachment, true)).mode).toBe("human");
		await f.service.bindRun("s", "run-next", "terminal");
		expect(f.actor.inputControl).toMatchObject({ mode: "agent", agentRunId: "run-next" });
		await f.service.unbindRun("s", "run-next");
		await expect(f.actor.close("user_requested")).resolves.toBeUndefined();
	});

	it("preserves an existing Run when its repeated binding fails", async () => {
		const f = await fixture();
		await f.service.bindRun("s", "run", "terminal");
		vi.spyOn(f.repository, "updateSession").mockImplementationOnce(() => { throw new Error("binding refresh failed"); });
		await expect(f.service.bindRun("s", "run", "terminal")).rejects.toThrow("binding refresh failed");
		expect(f.actor.inputControl).toMatchObject({ mode: "agent", agentRunId: "run" });
		await f.service.unbindRun("s", "run");
		await expect(f.actor.close("user_requested")).resolves.toBeUndefined();
	});

	it("ignores stale Run cleanup without revoking the current handoff receipt", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch,
			inputSequence: 1, bytes: Buffer.from("human input") });
		await f.service.bindRun("s", "run", "terminal");
		await f.service.unbindRun("s", "run");
		await f.service.bindRun("s", "run-next", "terminal");
		const activity = f.repository.latestHumanActivity("s")!;
		await f.interactions.acknowledgeHumanHandoff({ sessionId: "s", terminalSessionId: f.terminal.id,
			agentRunId: "run-next", activityId: activity.id, endSequence: activity.endSequence });
		await f.service.unbindRun("s", "run");
		expect(() => f.actor.requireAgentControl("run-next", true)).not.toThrow();
	});

	it("never replays an uncertain write and marks interrupted human records as incomplete on restart", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		const input = { terminalSessionId: f.terminal.id, controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("uncertain") };
		f.channel.writeError = true;
		await expect(f.service.writeHumanInput("s", attachment, input)).rejects.toMatchObject({ code: "terminal_input_uncertain" });
		await expect(f.service.writeHumanInput("s", attachment, input)).rejects.toMatchObject({ code: "terminal_control_conflict" });
		expect(f.channel.writes).toHaveLength(1);
		f.repository.recoverInterrupted(Date.now());
		expect(f.repository.latestHumanActivity("s")).toMatchObject({ writeStatus: "uncertain", truncated: true, endReason: "lost" });
	});

	it("preserves the internal input failure cause without exposing or replaying keyboard bytes", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		const cause = new Error("SSH write failed");
		vi.spyOn(f.channel, "write").mockRejectedValueOnce(cause);
		const input = { terminalSessionId: f.terminal.id, controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("hidden-secret") };
		await expect(f.service.writeHumanInput("s", attachment, input)).rejects.toMatchObject({ code: "terminal_input_uncertain", cause });
		await expect(f.service.writeHumanInput("s", attachment, input)).rejects.toMatchObject({ code: "terminal_control_conflict" });
		expect(JSON.stringify(f.db.prepare("SELECT * FROM terminal_human_activities").all())).not.toContain("hidden-secret");
		expect(f.channel.write).toHaveBeenCalledTimes(1);
	});

	it.each([
		["user_requested", "closed"],
		["backend_shutdown", "lost"],
	] as const)("finishes %s shutdown even when the final human checkpoint fails", async (reason, status) => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch,
			inputSequence: 1, bytes: Buffer.from("human input") });
		await f.actor.captureCanonical();
		const cause = new Error("final human checkpoint failed");
		vi.spyOn(f.repository, "saveHumanActivity").mockImplementationOnce(() => { throw cause; });

		await expect(f.actor.close(reason)).rejects.toBe(cause);
		expect(f.service.get("s")?.status).toBe(status);
		expect(f.service.getActor("s")).toBeUndefined();
		expect(f.channel.disposed).toBe(true);
		expect(f.repository.listTimeline("s", undefined, 100).some(event => event.type === `terminal.${status}`)).toBe(true);
		await expect(f.service.open({ sessionId: "s", requestId: "reopen" })).resolves.toMatchObject({ status: "opening" });
	});

	it("persists a foreground Shell exit despite a failed final human checkpoint", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch,
			inputSequence: 1, bytes: Buffer.from("exit\r") });
		await f.actor.captureCanonical();
		vi.spyOn(f.repository, "saveHumanActivity").mockImplementationOnce(() => { throw new Error("final checkpoint failed"); });
		await f.channel.close();
		await f.actor.captureCanonical();
		expect(f.service.get("s")?.status).toBe("closed");
		expect(f.service.getActor("s")).toBeUndefined();
		expect(f.channel.disposed).toBe(true);
	});

	it("retains both persistence failures while disposing a failed terminal shutdown", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch,
			inputSequence: 1, bytes: Buffer.from("human input") });
		await f.actor.captureCanonical();
		const checkpointError = new Error("checkpoint failed"), terminalError = new Error("terminal state failed");
		vi.spyOn(f.repository, "saveHumanActivity").mockImplementationOnce(() => { throw checkpointError; });
		const updateSession = f.repository.updateSession.bind(f.repository);
		vi.spyOn(f.repository, "updateSession").mockImplementation((next, ...args) => {
			if (next.status === "closed") throw terminalError;
			return updateSession(next, ...args);
		});
		await expect(f.actor.close("user_requested")).rejects.toMatchObject({ errors: [checkpointError, terminalError] });
		expect(f.service.getActor("s")).toBeUndefined();
		expect(f.channel.disposed).toBe(true);
	});

	it("validates bounded binary input and exposes control and input through REST", async () => {
		const f = await fixture(), attachment = await f.attach();
		const route = async (action: string, body: unknown) => {
			const request = new Request(`http://test/api/sessions/s/terminal/attachments/${attachment}/${action}`, { method: "POST", body: JSON.stringify(body) });
			return handleTerminalRoute(f.service, request, new URL(request.url), new URL(request.url).pathname.split("/").filter(Boolean));
		};
		const control = await (await route("control", { action: "claim" }))!.json() as { epoch: number };
		const input = { terminalSessionId: f.terminal.id, controlEpoch: control.epoch, inputSequence: 1, bytesBase64: Buffer.from([0, 255, 3]).toString("base64") };
		expect(await (await route("input", input))!.json()).toEqual({ acceptedSequence: 1 });
		expect([...f.channel.writes[0]!]).toEqual([0, 255, 3]);
		for (const bytesBase64 of ["", "not base64!", Buffer.alloc(32769).toString("base64")])
			expect(() => parseTerminalHumanInput({ ...input, bytesBase64 })).toThrow();
		await expect(route("input", { ...input, input: "forbidden" })).rejects.toMatchObject({ code: "validation_error" });
	});

	it("checkpoints visible activity before handoff and bounds CJK transcript plus screen to 64 KiB", async () => {
		const f = await fixture(), attachment = await f.attach();
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id, controlEpoch: control.epoch,
			inputSequence: 1, bytes: Buffer.from("probe\r") });
		f.channel.emit("checkpoint-visible\r\n");
		await expect.poll(() => f.repository.latestHumanActivity("s")?.transcript, { timeout: 1000 }).toContain("checkpoint-visible");
		f.channel.emit(("含".repeat(100) + "\r\n").repeat(3000));
		await f.actor.captureCanonical(); await f.service.bindRun("s", "run", "terminal");
		const activity = f.repository.latestHumanActivity("s")!;
		expect(Buffer.byteLength(activity.transcript) + Buffer.byteLength(activity.screenText)).toBeLessThanOrEqual(65536);
		expect(activity.truncated).toBe(true);
		expect(activity.transcript + activity.screenText).not.toContain("\ufffd");
	});
});
