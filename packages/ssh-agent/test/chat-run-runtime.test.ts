import { Agent } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ChatRunRuntime } from "../src/application/chat-run-runtime.ts";
import type { ChatRun } from "../src/domain/chat.ts";

const run: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "request-1",
	providerId: "runtime-provider",
	modelId: "runtime-model",
	thinkingLevel: "off",
	serverInteractionMode: "command",
	terminalSessionId: null,
	status: "running",
	createdAt: 1,
	updatedAt: 1,
};

function createRuntime() {
	const faux = fauxProvider({
		provider: "runtime-provider",
		models: [{ id: "runtime-model", contextWindow: 128_000, maxTokens: 8_192 }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = new Agent({
		initialState: { model: faux.getModel() },
		streamFn: (model, context, options) => models.streamSimple(model, context, options),
	});
	const env = new NodeExecutionEnv({ cwd: process.cwd() });
	return { runtime: new ChatRunRuntime({ run, agent, env }), agent, env };
}

describe("ChatRunRuntime", () => {
	it("owns cancellation, continuation, steering, and model state", () => {
		const { runtime } = createRuntime();
		expect(runtime.acceptsSteering).toBe(true);
		expect(runtime.consumeContinuationDecision()).toBe(true);

		runtime.stopAfterApprovalRejection();
		expect(runtime.acceptsSteering).toBe(false);
		expect(runtime.consumeContinuationDecision()).toBe(false);
		expect(runtime.consumeContinuationDecision()).toBe(true);

		runtime.beginTurn();
		runtime.requestCancellation();
		runtime.markModelRemoved();
		expect(runtime.acceptsSteering).toBe(true);
		expect(runtime.cancellationRequested).toBe(true);
		expect(runtime.modelRemoved).toBe(true);
	});

	it("disposes the Agent and execution environment exactly once", async () => {
		const { runtime, agent, env } = createRuntime();
		const abort = vi.spyOn(agent, "abort");
		const cleanup = vi.spyOn(env, "cleanup");

		const first = runtime.dispose();
		const second = runtime.dispose();
		expect(second).toBe(first);
		await Promise.all([first, second]);

		expect(abort).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
	});
});
