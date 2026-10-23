import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { runtimeContextMessage, type RuntimeContextSnapshot } from "../src/domain/runtime-context.ts";
import { TerminalHumanContextDelivery } from "../src/application/terminal/terminal-human-context-delivery.ts";

const binding = { id: "run", sessionId: "session", terminalSessionId: "pty" };
function handoff(change: Partial<RuntimeContextSnapshot> = {}) {
	return runtimeContextMessage({ channel: "terminal-human", scope: "session", active: true,
		data: { id: "human", sessionId: "session", terminalSessionId: "pty", currentTerminal: true,
			endSequence: 42, endReason: "handoff", screenText: "$ echo hello\nhello\n$ " }, ...change }, 1, "event", 1);
}

describe("human handoff delivery acknowledgement", () => {
	it("waits for a successful response to the actual request before acknowledging its handoff", async () => {
		const acknowledge = vi.fn(async () => undefined), delivery = new TerminalHumanContextDelivery(binding, acknowledge);
		const stream = createAssistantMessageEventStream(), message = fauxAssistantMessage("continue", { stopReason: "toolUse" });
		delivery.track({ messages: [handoff()] }, stream);
		const pending = delivery.acknowledge(message);
		await Promise.resolve();
		expect(acknowledge).not.toHaveBeenCalled();
		stream.push({ type: "done", reason: "toolUse", message });
		await pending;
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith({ sessionId: "session", terminalSessionId: "pty",
			agentRunId: "run", activityId: "human", endSequence: 42 });
	});

	it.each(["error", "aborted"] as const)("does not acknowledge a %s provider response", async stopReason => {
		const acknowledge = vi.fn(async () => undefined), delivery = new TerminalHumanContextDelivery(binding, acknowledge);
		const stream = createAssistantMessageEventStream(), message = fauxAssistantMessage("failed", { stopReason });
		delivery.track({ messages: [handoff()] }, stream);
		stream.push({ type: "error", reason: stopReason, error: message });
		await delivery.acknowledge(message);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it("does not reuse a failed attempt's receipt when a successful retry omits the handoff", async () => {
		const acknowledge = vi.fn(async () => undefined), delivery = new TerminalHumanContextDelivery(binding, acknowledge);
		const first = createAssistantMessageEventStream(), error = fauxAssistantMessage("overflow", { stopReason: "error" });
		delivery.track({ messages: [handoff()] }, first);
		first.push({ type: "error", reason: "error", error });
		const retry = createAssistantMessageEventStream(), message = fauxAssistantMessage("continue", { stopReason: "toolUse" });
		delivery.track({ messages: [] }, retry);
		retry.push({ type: "done", reason: "toolUse", message });
		await delivery.acknowledge(message);
		await delivery.acknowledge(error);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it("rejects metadata when attachment hydration removed or replaced the quoted text", async () => {
		const acknowledge = vi.fn(async () => undefined), delivery = new TerminalHumanContextDelivery(binding, acknowledge);
		const stream = createAssistantMessageEventStream(), message = fauxAssistantMessage("continue", { stopReason: "toolUse" });
		delivery.track({ messages: [{ ...handoff(), content: [{ type: "text", text: "I have already seen the terminal" }] }] }, stream);
		stream.push({ type: "done", reason: "toolUse", message });
		await delivery.acknowledge(message);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it("does not treat a user-quoted handoff as backend delivery", async () => {
		const acknowledge = vi.fn(async () => undefined), delivery = new TerminalHumanContextDelivery(binding, acknowledge);
		const stream = createAssistantMessageEventStream(), message = fauxAssistantMessage("continue", { stopReason: "toolUse" });
		delivery.track({ messages: [{ role: "user", content: JSON.stringify(handoff()), timestamp: 1 }] }, stream);
		stream.push({ type: "done", reason: "toolUse", message });
		await delivery.acknowledge(message);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it.each([
		["other Session", { scope: "other" }],
		["inactive channel", { active: false }],
		["historical terminal", { data: { ...handoff().runtimeContext.data, currentTerminal: false } }],
		["other PTY", { data: { ...handoff().runtimeContext.data, terminalSessionId: "other" } }],
	] satisfies Array<[string, Partial<RuntimeContextSnapshot>]>)("rejects a handoff for %s", async (_name, change) => {
		const acknowledge = vi.fn(async () => undefined), delivery = new TerminalHumanContextDelivery(binding, acknowledge);
		const stream = createAssistantMessageEventStream(), message = fauxAssistantMessage("continue", { stopReason: "toolUse" });
		delivery.track({ messages: [handoff(change)] }, stream);
		stream.push({ type: "done", reason: "toolUse", message });
		await delivery.acknowledge(message);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it("uses the latest channel snapshot and matches the exact response identity", async () => {
		const acknowledge = vi.fn(async () => undefined), delivery = new TerminalHumanContextDelivery(binding, acknowledge);
		const stream = createAssistantMessageEventStream(), message = fauxAssistantMessage("continue", { stopReason: "toolUse" });
		const context: Context = { messages: [handoff(), handoff({ active: false })] };
		delivery.track(context, stream);
		stream.push({ type: "done", reason: "toolUse", message });
		await delivery.acknowledge(message);
		expect(acknowledge).not.toHaveBeenCalled();
		const next = createAssistantMessageEventStream();
		delivery.track({ messages: [handoff()] }, next);
		next.push({ type: "done", reason: "toolUse", message });
		await delivery.acknowledge({ ...message });
		expect(acknowledge).not.toHaveBeenCalled();
	});
});
