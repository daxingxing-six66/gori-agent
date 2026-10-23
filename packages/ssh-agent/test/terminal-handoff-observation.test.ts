import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalHumanHandoffReceipt } from "../src/domain/terminal-human.ts";
import type { TerminalInteractionRequest } from "../src/application/terminal/terminal-interaction-policy.ts";
import { humanFixture } from "./terminal-human-fixture.ts";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of close.splice(0)) await cleanup(); });

async function fixture(screen?: string) {
	const f = await humanFixture(); close.push(f.cleanup);
	const attachment = await f.attach(), control = await f.service.controlInput("s", attachment, true);
	await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id,
		controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("echo HUMAN\r") });
	if (screen) f.channel.emit(screen);
	await f.service.bindRun("s", "run", "terminal");
	const activity = f.repository.latestHumanActivity("s")!;
	const receipt: TerminalHumanHandoffReceipt = { sessionId: "s", terminalSessionId: f.terminal.id,
		agentRunId: "run", activityId: activity.id, endSequence: activity.endSequence };
	const request: TerminalInteractionRequest = { sessionId: "s", terminalSessionId: f.terminal.id,
		agentRunId: "run", toolCallId: "agent", action: { type: "submit", input: "echo AGENT" }, expectation: "streaming" };
	return { ...f, receipt, request, attachment };
}

describe("delivered human handoff observations", () => {
	it("requires a matching delivered handoff before reusing a stable screen for the first write", async () => {
		const f = await fixture();
		await expect(f.actor.write(Buffer.from("blocked"), "run")).rejects.toMatchObject({ code: "terminal_observe_required" });
		for (const receipt of [{ ...f.receipt, activityId: "old" }, { ...f.receipt, endSequence: f.receipt.endSequence - 1 },
			{ ...f.receipt, terminalSessionId: "other" }]) {
			await f.interactions.acknowledgeHumanHandoff(receipt);
			await expect(f.interactions.preflightSubmit(f.request, false)).rejects.toMatchObject({ code: "terminal_observe_required" });
		}
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await f.interactions.preflightSubmit(f.request, false);
		await f.interactions.execute(f.request);
		expect(f.channel.writes.map(bytes => Buffer.from(bytes).toString())).toEqual(["echo HUMAN\r", "echo AGENT\r"]);
		expect(f.db.prepare("SELECT count(*) AS n FROM terminal_interactions WHERE json_extract(action_json,'$.type')='observe'").get()?.n).toBe(0);
	});

	it("allows a complete alternate screen even when historical transcript was redrawn", async () => {
		const f = await fixture("\x1b[?1049h\x1b[2J\x1b[Hvim: unfinished edit");
		expect(f.repository.latestHumanActivity("s")).toMatchObject({ truncated: true, screenTruncated: false });
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await f.actor.write(Buffer.from("j"), "run");
		expect(f.channel.writes.map(bytes => Buffer.from(bytes).toString())).toEqual(["echo HUMAN\r", "j"]);
	});

	it("ignores ownership and audit changes while rejecting a resized screen even after resizing back", async () => {
		const f = await fixture();
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		const owner = await f.actor.claimResizeOwnership(f.attachment);
		await f.actor.recordDurableEvent("terminal.observation.processing", { syntheticMetadata: true });
		expect(() => f.actor.requireAgentControl("run", true)).not.toThrow();
		const geometry = f.actor.view.geometry;
		await f.actor.resize(f.attachment, owner.ownershipEpoch!, { ...geometry, cols: geometry.cols + 1 });
		await f.actor.resize(f.attachment, owner.ownershipEpoch!, geometry);
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await expect(f.actor.write(Buffer.from("blocked"), "run")).rejects.toMatchObject({ code: "terminal_observe_required" });
		expect(f.channel.writes).toHaveLength(1);
	});

	it("advances only to the delivered handoff and observes later output without repeating its transcript", async () => {
		const f = await fixture();
		f.channel.emit("\r\nLATER OUTPUT\r\n"); await f.actor.captureCanonical();
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await expect(f.actor.write(Buffer.from("blocked"), "run")).rejects.toMatchObject({ code: "terminal_observe_required" });
		const observed = await f.interactions.execute({ ...f.request, action: { type: "observe" }, expectation: "finite" });
		expect(observed.observation.startSequence).toBe(f.receipt.endSequence);
		expect(observed.observation.agentViewText).toContain("LATER OUTPUT");
		expect(observed.observation.agentViewText).not.toContain("HUMAN");
		await f.interactions.markDelivered(observed);
		// A continuous program can change again after an explicit sample; it does not create an infinite first-write barrier.
		f.channel.emit("another refresh\r\n"); await f.actor.captureCanonical();
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await f.actor.write(Buffer.from("\x03"), "run");
		expect(f.channel.writes).toHaveLength(2);
	});

	it("rechecks queued output immediately before PTY write and records a definite rejection", async () => {
		const f = await fixture();
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await f.interactions.preflightSubmit(f.request, false);
		const record = f.actor.recordDurableEvent.bind(f.actor);
		vi.spyOn(f.actor, "recordDurableEvent").mockImplementation(async (type, data) => {
			const sequence = await record(type, data);
			if (type === "terminal.input") f.channel.emit("changed while preparing to write\r\n");
			return sequence;
		});
		await expect(f.interactions.execute(f.request)).rejects.toMatchObject({ code: "terminal_observe_required" });
		const interaction = f.repository.findInteractionByToolCall("run", "agent")!;
		expect(interaction).toMatchObject({ status: "failed", failure: { code: "terminal_observe_required" } });
		expect(f.repository.findInputByInteraction(interaction.id)).toMatchObject({ status: "blocked", writtenAt: null });
		expect(f.channel.writes).toHaveLength(1);
	});

	it("does not resurrect old receipts after a successful Agent write or explicit observation", async () => {
		const f = await fixture();
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await f.actor.write(Buffer.from("AGENT"), "run");
		await f.actor.captureCanonical();
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await f.actor.write(Buffer.from("NEXT"), "run");
		await f.service.unbindRun("s", "run");
		await f.service.bindRun("s", "run-2", "terminal");
		await expect(f.interactions.acknowledgeHumanHandoff(f.receipt)).rejects.toMatchObject({ code: "terminal_control_conflict" });
		expect(f.channel.writes).toHaveLength(3);
	});

	it("refuses to reuse an incomplete current screen", async () => {
		const f = await humanFixture(); close.push(f.cleanup);
		const attachment = await f.attach(), owner = await f.actor.claimResizeOwnership(attachment);
		await f.actor.resize(attachment, owner.ownershipEpoch!, { rows: 120, cols: 320 });
		const control = await f.service.controlInput("s", attachment, true);
		await f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id,
			controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("command\r") });
		f.channel.emit(("\u0800".repeat(319) + "\r\n").repeat(120));
		await f.service.bindRun("s", "run", "terminal");
		const activity = f.repository.latestHumanActivity("s")!;
		expect(activity.screenTruncated).toBe(true);
		await f.interactions.acknowledgeHumanHandoff({ sessionId: "s", terminalSessionId: f.terminal.id, agentRunId: "run",
			activityId: activity.id, endSequence: activity.endSequence });
		await expect(f.actor.write(Buffer.from("blocked"), "run")).rejects.toMatchObject({ code: "terminal_observe_required" });
		expect(f.channel.writes).toHaveLength(1);
	});

	it("requires explicit observation after an uncertain human write even when its screen is complete", async () => {
		const f = await humanFixture(); close.push(f.cleanup);
		const attachment = await f.attach(), control = await f.service.controlInput("s", attachment, true);
		f.channel.writeError = true;
		await expect(f.service.writeHumanInput("s", attachment, { terminalSessionId: f.terminal.id,
			controlEpoch: control.epoch, inputSequence: 1, bytes: Buffer.from("uncertain") })).rejects.toMatchObject({ code: "terminal_input_uncertain" });
		f.channel.writeError = false;
		await f.service.bindRun("s", "run", "terminal");
		const activity = f.repository.latestHumanActivity("s")!;
		expect(activity).toMatchObject({ writeStatus: "uncertain", screenTruncated: false });
		await f.interactions.acknowledgeHumanHandoff({ sessionId: "s", terminalSessionId: f.terminal.id, agentRunId: "run",
			activityId: activity.id, endSequence: activity.endSequence });
		await expect(f.actor.write(Buffer.from("blocked"), "run")).rejects.toMatchObject({ code: "terminal_observe_required" });
		expect(f.channel.writes).toHaveLength(1);
	});

	it("consumes reuse before dispatch so an uncertain Agent write cannot be retried from the old receipt", async () => {
		const f = await fixture();
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await f.interactions.preflightSubmit(f.request, false);
		f.channel.writeError = true;
		await expect(f.interactions.execute(f.request)).rejects.toThrow("simulated SSH write failure");
		const interaction = f.repository.findInteractionByToolCall("run", "agent")!;
		expect(interaction.status).toBe("write_uncertain");
		f.channel.writeError = false;
		await f.interactions.acknowledgeHumanHandoff(f.receipt);
		await expect(f.actor.write(Buffer.from("must observe"), "run")).rejects.toMatchObject({ code: "terminal_observe_required" });
		expect(f.channel.writes).toHaveLength(2);
	});
});
