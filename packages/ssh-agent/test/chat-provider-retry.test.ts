import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, hasApi, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../../ai/src/api/openai-completions.ts";
import { ChatAgentRuntimeFactory } from "../src/application/services/chat-agent-runtime-factory.ts";
import type { ChatRun } from "../src/domain/chat.ts";

const model: Model<"openai-completions"> = {
	id: "retry-model", name: "Retry test model", provider: "retry-provider", api: "openai-completions",
	baseUrl: "https://provider.invalid/v1", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_192,
};
const run: ChatRun = {
	id: "retry-run", sessionId: "retry-session", workspaceId: "retry-workspace", requestId: "retry-request",
	providerId: model.provider, modelId: model.id, thinkingLevel: "off", serverInteractionMode: "command",
	terminalSessionId: null, status: "pending", createdAt: 1, updatedAt: 1,
};

function tool(name: string): AgentTool {
	return { name, label: name, description: name, parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }) };
}

async function createRuntime(request: typeof fetch, remote = tool("remote_server_call")) {
	const models = createModels();
	models.setProvider(createProvider<"openai-completions">({
		id: model.provider, name: "Retry test provider", models: [model],
		auth: { apiKey: { name: "Test key", resolve: async () => ({
			auth: { apiKey: "test-only" }, source: "test",
		}) } },
		api: { stream, streamSimple: (selectedModel, context, options) => {
			if (!hasApi(selectedModel, "openai-completions")) throw new Error("Expected OpenAI Completions model");
			return streamSimple(selectedModel, context, { ...options, fetch: request });
		} },
	}));
	const factory = new ChatAgentRuntimeFactory({
		models,
		toolCalls: { beforeToolCall: async () => undefined,
			requestSftpOverwriteApproval: async () => ({ approved: true, source: "user" }) },
		queues: { cancelSteeringAfterTurn: () => undefined },
		agentEvents: { handle: () => undefined },
		attachments: { hydrateProviderContext: async (_sessionId, context) => context },
		decisions: { request: async () => [{ kind: "skipped" }] },
		createRemoteTool: () => remote,
		createTerminalTool: () => tool("terminal_interaction"),
		createSftpTool: () => tool("sftp_upload"),
		createSftpDownloadTool: () => tool("sftp_download"),
	});
	return factory.create({ run, model, workDir: process.cwd(), history: [], systemPrompt: "Retry test" });
}

function errorResponse(status: number, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify({ error: { message: "Provider unavailable" } }), {
		status, headers: { "content-type": "application/json", ...headers },
	});
}

function completionResponse(toolCall = false): Response {
	const delta = toolCall
		? { tool_calls: [{ index: 0, id: "call-1", type: "function",
			function: { name: "remote_server_call", arguments: "{}" } }] }
		: { content: "Recovered" };
	const chunks = [
		{ id: "completion-1", choices: [{ index: 0, delta }] },
		{ id: "completion-1", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] },
	];
	return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
}

const prompt = { role: "user" as const, content: "hello", timestamp: 1 };

describe("main chat provider HTTP retries", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("recovers from 429, 5xx and network failures with exponential backoff", async () => {
		const request = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(errorResponse(429))
			.mockResolvedValueOnce(errorResponse(503))
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(completionResponse());
		const runtime = await createRuntime(request);
		try {
			const pending = runtime.prompt(prompt);
			await vi.advanceTimersByTimeAsync(0);
			expect(request).toHaveBeenCalledTimes(1);
			for (const [index, delay] of [2000, 4000, 8000].entries()) {
				await vi.advanceTimersByTimeAsync(delay - 1);
				expect(request).toHaveBeenCalledTimes(index + 1);
				await vi.advanceTimersByTimeAsync(1);
				expect(request).toHaveBeenCalledTimes(index + 2);
			}
			await pending;
			expect(runtime.publicFailure).toBeUndefined();
			expect(runtime.context.messages.at(-1)).toMatchObject({
				role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered" }],
			});
		} finally { await runtime.dispose(); }
	});

	it.each([429, 500, 503, 599, "network"] as const)("stops after three retries for %s", async (failure) => {
		const request = vi.fn<typeof fetch>().mockImplementation(async () => {
			if (failure === "network") throw new TypeError("fetch failed");
			return errorResponse(failure);
		});
		const runtime = await createRuntime(request);
		try {
			const pending = runtime.prompt(prompt);
			await vi.advanceTimersByTimeAsync(14_000);
			await pending;
			expect(request).toHaveBeenCalledTimes(4);
			expect(runtime.publicFailure).toBeDefined();
			expect(runtime.context.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		} finally { await runtime.dispose(); }
	});

	it.each([400, 401, 403])("fails immediately for HTTP %s", async (status) => {
		const request = vi.fn<typeof fetch>().mockImplementation(async () => errorResponse(status));
		const runtime = await createRuntime(request);
		try {
			await runtime.prompt(prompt);
			expect(request).toHaveBeenCalledOnce();
			expect(runtime.publicFailure).toBeDefined();
		} finally { await runtime.dispose(); }
	});

	it.each([undefined, "30"])("cancels backoff without sending another request, Retry-After=%s", async (retryAfter) => {
		const request = vi.fn<typeof fetch>().mockImplementation(async () =>
			errorResponse(429, retryAfter ? { "retry-after": retryAfter } : undefined));
		const runtime = await createRuntime(request);
		try {
			const pending = runtime.prompt(prompt);
			await vi.advanceTimersByTimeAsync(0);
			expect(request).toHaveBeenCalledOnce();
			runtime.requestCancellation();
			runtime.abortAgent();
			await pending;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(request).toHaveBeenCalledOnce();
			expect(runtime.context.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
			expect(runtime.publicFailure).toBeUndefined();
		} finally { await runtime.dispose(); }
	});

	it("applies the retry budget to requests after tools without replaying the tool", async () => {
		const request = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(completionResponse(true))
			.mockResolvedValueOnce(errorResponse(503))
			.mockResolvedValueOnce(errorResponse(503))
			.mockResolvedValueOnce(errorResponse(503))
			.mockResolvedValueOnce(completionResponse());
		const remote = tool("remote_server_call");
		const execute = vi.spyOn(remote, "execute");
		const runtime = await createRuntime(request, remote);
		try {
			const pending = runtime.prompt(prompt);
			await vi.advanceTimersByTimeAsync(14_000);
			await pending;
			expect(request).toHaveBeenCalledTimes(5);
			expect(execute).toHaveBeenCalledOnce();
			expect(runtime.context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
			expect(runtime.publicFailure).toBeUndefined();
		} finally { await runtime.dispose(); }
	});
});
