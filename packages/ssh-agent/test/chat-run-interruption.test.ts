import { Agent, CompactionError, type AgentMessage } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ChatRunRuntime } from "../src/application/chat-run-runtime.ts";
import { ChatCompactionError } from "../src/domain/context-compaction.ts";
import type { ChatRun } from "../src/domain/chat.ts";

const run: ChatRun = {
	id: "run", sessionId: "session", workspaceId: "workspace", requestId: "request", providerId: "interruption", modelId: "model",
	thinkingLevel: "off", serverInteractionMode: "command", terminalSessionId: null, status: "running", createdAt: 1, updatedAt: 1,
};
const message: AgentMessage = { role: "user", content: "initial", timestamp: 1 };

function fixture() {
	const faux = fauxProvider({ provider: "interruption", models: [{ id: "model" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	let runtime: ChatRunRuntime;
	const agent = new Agent({
		initialState: { model: faux.getModel() },
		streamFn: (model, context, options) => models.streamSimple(model, context, options),
		onRunFailure: (error) => runtime.captureFailure(error),
		shouldStopAfterTurn: () => runtime.stoppingCurrentTurn,
	});
	runtime = new ChatRunRuntime({ run: { ...run }, agent, env: new NodeExecutionEnv({ cwd: process.cwd() }) });
	return { runtime, agent, faux };
}

describe("Chat Run interruption boundaries", () => {
	it("allows force cancellation to supersede a queued continuation", async () => {
		const f = fixture();
		let started = () => {};
		const ready = new Promise<void>((resolve) => { started = resolve; });
		f.faux.setResponses([async (_context, options) => {
			started();
			await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("interrupted");
		}]);
		try {
			const running = f.runtime.prompt(message);
			await ready;
			f.runtime.followUp({ ...message, content: "next", timestamp: 2 });
			let loaded = false;
			f.runtime.interruptForQueuedMessages(() => { loaded = true; return [{ behavior: "follow_up", message: { ...message, content: "next", timestamp: 2 } }]; });
			f.runtime.requestCancellation();
			await running;
			expect(loaded).toBe(false);
			expect(f.faux.state.callCount).toBe(1);
			expect(f.runtime.cancellationRequested).toBe(true);
			expect(f.runtime.publicFailure).toBeUndefined();
		} finally { await f.runtime.dispose(); }
	});

	it("treats an empty queue after interruption as cancellation", async () => {
		const f = fixture();
		f.faux.setResponses([fauxAssistantMessage("finished")]);
		f.runtime.interruptForQueuedMessages(() => []);
		try {
			await f.runtime.prompt(message);
			expect(f.runtime.cancellationRequested).toBe(true);
			expect(f.faux.state.callCount).toBe(1);
		} finally { await f.runtime.dispose(); }
	});

	it("recognizes an explicitly aborted summary while retaining real failures", async () => {
		const f = fixture();
		f.runtime.interruptForQueuedMessages(() => []);
		try {
			const cancellation = f.runtime.toAgentError(new ChatCompactionError("chat_context_compaction_failed", "stopped", {
				cause: new CompactionError("aborted", "stopped"),
			}));
			expect(cancellation.name).toBe("AbortError");
			f.runtime.captureFailure(cancellation);
			expect(f.runtime.publicFailure).toBeUndefined();
			const failure = f.runtime.toAgentError(new ChatCompactionError("chat_context_compaction_failed", "summary failed", {
				cause: new CompactionError("summarization_failed", "real failure"),
			}));
			expect(failure.name).not.toBe("AbortError");
			expect(f.runtime.publicFailure).toMatchObject({ code: "chat_context_compaction_failed" });
		} finally { await f.runtime.dispose(); }
	});
});
