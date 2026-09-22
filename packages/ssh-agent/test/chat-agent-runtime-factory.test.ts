import { Agent, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { ChatAgentRuntimeFactory } from "../src/application/services/chat-agent-runtime-factory.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import { ChatCompactionError } from "../src/domain/context-compaction.ts";

const commandRun: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "request-1",
	providerId: "factory-provider",
	modelId: "factory-model",
	thinkingLevel: "off",
	serverInteractionMode: "command",
	terminalSessionId: null,
	status: "pending",
	createdAt: 1,
	updatedAt: 1,
};

function namedTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	};
}

function createContext(
	options: { createExecutionEnv?: (workDir: string) => NodeExecutionEnv; provider?: string } = {},
) {
	const faux = fauxProvider({
		provider: options.provider ?? "factory-provider",
		models: [{ id: "factory-model", contextWindow: 128_000, maxTokens: 8_192 }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	let agentOptions: AgentOptions | undefined;
	let agent: Agent | undefined;
	let remoteAbort: (() => void) | undefined;
	const createRemoteTool = vi.fn((_sessionId: string, abortRun?: () => void) => {
		remoteAbort = abortRun;
		return namedTool("remote_server_call");
	});
	const createTerminalTool = vi.fn(() => namedTool("terminal_interaction"));
	const factory = new ChatAgentRuntimeFactory({
		models,
		toolCalls: {
			beforeToolCall: vi.fn(async () => undefined),
			requestSftpOverwriteApproval: vi.fn(async () => ({ approved: true as const, source: "user" as const })),
		},
		queues: { cancelSteeringAfterTurn: vi.fn() },
		agentEvents: { handle: vi.fn() },
		attachments: { hydrateProviderContext: vi.fn(async (_sessionId, providerContext) => providerContext) },
		createRemoteTool,
		createTerminalTool,
		createSftpTool: vi.fn(() => namedTool("sftp_upload")),
		createSftpDownloadTool: vi.fn(() => namedTool("sftp_download")),
		createAgent: (options) => {
			agentOptions = options;
			agent = new Agent(options);
			return agent;
		},
		...(options.createExecutionEnv === undefined ? {} : { createExecutionEnv: options.createExecutionEnv }),
	});
	return {
		factory,
		faux,
		model: faux.getModel(),
		models,
		createRemoteTool,
		createTerminalTool,
		getAgentOptions: () => agentOptions,
		getAgent: () => agent,
		getRemoteAbort: () => remoteAbort,
	};
}

describe("ChatAgentRuntimeFactory", () => {
	it("keeps internal compaction failures non-retryable and clears request-local state", async () => {
		const context = createContext();
		const runtime = await context.factory.create({
			run: commandRun,
			model: context.model,
			workDir: process.cwd(),
			history: [],
			systemPrompt: "immutable snapshot",
		});
		try {
			runtime.toAgentError(new ChatCompactionError("chat_context_compaction_failed", "private internal failure"));
			const message = {
				...fauxAssistantMessage("", { stopReason: "error", errorMessage: "private internal failure" }),
				errorCode: "context_compaction_failed" as const,
			};
			runtime.annotateFailure({ type: "message_end", message });
			context.getAgent()!.state.messages = [message];
			expect(runtime.publicFailure).toMatchObject({
				code: "chat_context_compaction_failed",
				messageKey: "chat.context_compaction_failed",
				retryable: false,
			});
			runtime.beginProviderRequest();
			context.getAgent()!.state.messages = [
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "unrelated failure" }),
			];
			expect(runtime.publicFailure).toMatchObject({ code: "chat_run_failed", messageKey: "chat.run_failed" });
		} finally {
			await runtime.dispose();
		}
	});
	it.each(["steer", "followUp"] as const)("normalizes errors after consuming %s messages", async (behavior) => {
		const context = createContext();
		const runtime = await context.factory.create({
			run: commandRun,
			model: context.model,
			workDir: process.cwd(),
			history: [],
			systemPrompt: "immutable snapshot",
		});
		context.faux.setResponses([
			() => {
				runtime[behavior]({ role: "user", content: "queued message", timestamp: 2 });
				return fauxAssistantMessage("first turn");
			},
			fauxAssistantMessage("", { stopReason: "error", errorMessage: '402: {"message":"Insufficient balance"}' }),
		]);
		try {
			await runtime.prompt({ role: "user", content: "hello", timestamp: 1 });
			expect(context.faux.state.callCount).toBe(2);
			expect(runtime.publicFailure).toMatchObject({
				code: "chat_provider_request_rejected",
				messageKey: "provider.request_failed",
				retryable: false,
			});
			expect(runtime.publicFailure?.message).toContain("Insufficient balance (HTTP 402)");
		} finally {
			await runtime.dispose();
		}
	});
	it("does not misclassify a synchronous model exception as attachment storage failure", async () => {
		const context = createContext();
		const runtime = await context.factory.create({
			run: commandRun,
			model: context.model,
			workDir: process.cwd(),
			history: [],
			systemPrompt: "immutable snapshot",
		});
		vi.spyOn(context.models, "streamSimple").mockImplementation(() => {
			throw Object.assign(new Error("max_tokens must be <= 8192"), { status: 400 });
		});
		try {
			await runtime.prompt({ role: "user", content: "hello", timestamp: 1 });
			expect(runtime.publicFailure).toMatchObject({
				code: "chat_provider_request_rejected",
				messageKey: "provider.request_failed",
				retryable: false,
			});
			expect(runtime.publicFailure?.message).toContain("max_tokens must be <= 8192");
			expect(runtime.errorCode).not.toBe("chat_attachment_storage_unavailable");
		} finally {
			await runtime.dispose();
		}
	});
	it("adds stable Session headers only for the OpenCode Go provider", async () => {
		const context = createContext({ provider: "opencode-go" });
		const runtime = await context.factory.create({
			run: commandRun,
			model: context.model,
			workDir: process.cwd(),
			history: [],
			systemPrompt: "immutable snapshot",
		});
		const streamSimple = vi.spyOn(context.models, "streamSimple");
		const providerContext: Context = { messages: [] };
		const requestOptions: SimpleStreamOptions = { headers: { "x-existing-header": "preserved" } };
		const streamFn = context.getAgentOptions()?.streamFn;
		if (!streamFn) throw new Error("Agent stream function was not configured");

		await streamFn(context.model, providerContext, requestOptions);

		expect(streamSimple).toHaveBeenCalledWith(context.model, providerContext, {
			...requestOptions,
			sessionId: "session-1",
			headers: {
				"x-existing-header": "preserved",
				"x-opencode-session": "session-1",
				"x-opencode-client": "pi",
			},
		});
		await runtime.dispose();
	});

	it("does not change request options for other providers", async () => {
		const context = createContext();
		const runtime = await context.factory.create({
			run: commandRun,
			model: context.model,
			workDir: process.cwd(),
			history: [],
			systemPrompt: "immutable snapshot",
		});
		const streamSimple = vi.spyOn(context.models, "streamSimple");
		const providerContext: Context = { messages: [] };
		const requestOptions: SimpleStreamOptions = { headers: { "x-existing-header": "preserved" } };
		const streamFn = context.getAgentOptions()?.streamFn;
		if (!streamFn) throw new Error("Agent stream function was not configured");

		await streamFn(context.model, providerContext, requestOptions);

		expect(streamSimple).toHaveBeenCalledWith(context.model, providerContext, requestOptions);
		await runtime.dispose();
	});

	it("creates the frozen command-mode Agent configuration", async () => {
		const context = createContext();
		const runtime = await context.factory.create({
			run: commandRun,
			model: context.model,
			workDir: process.cwd(),
			history: [],
			systemPrompt: "immutable snapshot",
		});
		const options = context.getAgentOptions();
		expect(options?.initialState?.systemPrompt).toBe("immutable snapshot");

		expect(options?.initialState?.tools?.map((tool) => tool.name)).toEqual([
			"read",
			"write",
			"bash",
			"remote_server_call",
			"terminal_interaction",
			"sftp_upload",
			"sftp_download",
		]);
		expect(options).toMatchObject({
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		});
		for (const tool of options?.initialState?.tools ?? []) {
			const parallel = ["read", "sftp_upload", "sftp_download"].includes(tool.name);
			expect(tool.executionMode).toBe(parallel ? "parallel" : "sequential");
			if (parallel) expect(tool.requiresSequentialExecution).toBeTypeOf("function");
		}
		expect(context.createRemoteTool).toHaveBeenCalledWith("session-1", expect.any(Function));
		expect(context.createTerminalTool).not.toHaveBeenCalled();

		const abort = vi.spyOn(context.getAgent()!, "abort");
		context.getRemoteAbort()?.();
		expect(abort).toHaveBeenCalledOnce();
		await runtime.dispose();
	});

	it("keeps both definitions and the supplied snapshot in Terminal Mode", async () => {
		const context = createContext();
		const run: ChatRun = {
			...commandRun,
			serverInteractionMode: "terminal",
			terminalSessionId: "terminal-1",
		};
		const runtime = await context.factory.create({
			run,
			model: context.model,
			workDir: process.cwd(),
			history: [],
			systemPrompt: "immutable snapshot",
		});
		const options = context.getAgentOptions();
		expect(options?.initialState?.systemPrompt).toBe("immutable snapshot");

		expect(options?.initialState?.tools?.map((tool) => tool.name)).toEqual([
			"read",
			"write",
			"bash",
			"remote_server_call",
			"terminal_interaction",
			"sftp_upload",
			"sftp_download",
		]);
		expect(context.createRemoteTool).not.toHaveBeenCalled();
		expect(context.createTerminalTool).toHaveBeenCalledWith({
			sessionId: "session-1",
			terminalSessionId: "terminal-1",
			agentRunId: "run-1",
		});
		await runtime.dispose();
	});

	it("cleans the execution environment when Agent construction fails", async () => {
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const cleanup = vi.spyOn(env, "cleanup");
		const context = createContext({ createExecutionEnv: () => env });
		const factory = new ChatAgentRuntimeFactory({
			models: createModels(),
			toolCalls: {
				beforeToolCall: vi.fn(async () => undefined),
				requestSftpOverwriteApproval: vi.fn(async () => ({ approved: true as const, source: "user" as const })),
			},
			queues: { cancelSteeringAfterTurn: vi.fn() },
			agentEvents: { handle: vi.fn() },
			attachments: { hydrateProviderContext: vi.fn(async (_sessionId, providerContext) => providerContext) },
			createRemoteTool: () => namedTool("remote_server_call"),
			createTerminalTool: () => namedTool("terminal_interaction"),
			createSftpTool: () => namedTool("sftp_upload"),
			createSftpDownloadTool: () => namedTool("sftp_download"),
			createExecutionEnv: () => env,
			createAgent: () => {
				throw new Error("Agent construction failed");
			},
		});

		await expect(
			factory.create({
				run: commandRun,
				model: context.model,
				workDir: process.cwd(),
				history: [],
			systemPrompt: "immutable snapshot",
			}),
		).rejects.toThrow("Agent construction failed");
		expect(cleanup).toHaveBeenCalledOnce();
	});
});
