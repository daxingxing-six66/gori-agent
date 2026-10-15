import { Agent, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { ChatAgentRuntimeFactory, type ChatAgentRuntimeFactoryOptions } from "../src/application/services/chat-agent-runtime-factory.ts";
import { ChatToolAuthorizationPolicy } from "../src/application/services/chat-tool-authorization-policy.ts";
import { ChatToolCallCoordinator } from "../src/application/services/chat-tool-call-coordinator.ts";
import { evaluateRemoteSandboxRoute } from "../src/application/services/remote-sandbox-routing.ts";
import { createRemoteServerCallTool, remoteServerCallDefinition } from "../src/application/tools/remote-server-call-tool.ts";
import { RemoteCommandExecutionPlan } from "../src/application/tools/remote-command-execution-plan.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import type { CommandOperationResult, SubmitCommandInput } from "../src/application/services/command-operation-service.ts";
import { sandboxFailure } from "../src/domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { createTerminalInteractionTool, terminalInteractionDefinition } from "../src/application/tools/terminal-interaction-tool.ts";
import type { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import type { AgentDeploymentService } from "../src/application/tools/deployment-agent-tool.ts";
import type { Session } from "../src/domain/session.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import type { DeploymentRun } from "../src/domain/deployment.ts";
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

const session: Session = { id: "session-1", workspaceId: "workspace-1", displayName: "test", workDir: null,
	autoAudit: false, sandboxEnabled: true, terminalContextCursor: 0, revision: 1, createdAt: 1, updatedAt: 1 };

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
	options: { createExecutionEnv?: (workDir: string) => NodeExecutionEnv; provider?: string; deployments?: AgentDeploymentService;
		toolCalls?: ChatAgentRuntimeFactoryOptions["toolCalls"]; sandboxPolicy?: ChatAgentRuntimeFactoryOptions["sandboxPolicy"] } = {},
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
		sandboxPolicy: options.sandboxPolicy,
		models,
		toolCalls: options.toolCalls ?? {
			beforeToolCall: vi.fn(async () => undefined),
			requestSftpOverwriteApproval: vi.fn(async () => ({ approved: true as const, source: "user" as const })),
		},
		queues: { cancelSteeringAfterTurn: vi.fn() },
		agentEvents: { handle: vi.fn() },
		attachments: { hydrateProviderContext: vi.fn(async (_sessionId, providerContext) => providerContext) },
		decisions: { request: vi.fn(async () => [{ kind: "skipped" as const }]) },
		...(options.deployments === undefined ? {} : { deployments: options.deployments }),
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
	it("refreshes the trusted sandbox instruction for each Run without changing the base snapshot", async () => {
		let mode: "workspace_write" | "full_access" = "full_access";
		const sandboxPolicy = { mode: vi.fn(async () => mode) };
		const context = createContext({ sandboxPolicy });
		const input = { run: commandRun, model: context.model, workDir: process.cwd(), history: [], systemPrompt: "immutable snapshot" };
		const direct = await context.factory.create(input);
		try { expect(context.getAgentOptions()?.initialState?.systemPrompt).toContain("disabled remote sandboxing for this Session"); }
		finally { await direct.dispose(); }
		mode = "workspace_write";
		const confined = await context.factory.create(input);
		try {
			expect(context.getAgentOptions()?.initialState?.systemPrompt).toContain("Remote sandboxing is enabled");
			expect(input.systemPrompt).toBe("immutable snapshot");
			expect(sandboxPolicy.mode).toHaveBeenCalledTimes(2);
		} finally { await confined.dispose(); }
	});
	it("carries the selected Full Access plan from human approval through Agent into the remote tool", async () => {
		const target = { defaultCwd: "/srv/app" } as SshTargetSnapshot;
		const sandboxApprovals = new RemoteSandboxApprovalStore();
		const authorization = new ChatToolAuthorizationPolicy({ sandboxApprovals,
			sessions: { findById: vi.fn(async () => session) },
			terminalInteractions: { preflightSubmit: vi.fn(), approve: vi.fn(), reject: vi.fn() },
			preflightRemoteGuard: async () => ({ allowed: true }),
			assessRemoteSandbox: async () => ({ target, route: { mode: "full_access", reason: "write_path_outside_sandbox",
				details: "Declared path /etc/config is outside the writable roots" } }),
		});
		const approvals = { request: vi.fn(async () => ({ approved: true as const, source: "user" as const })) };
		const context = createContext({ toolCalls: new ChatToolCallCoordinator({ authorization, approvals }) });
		const submit = vi.fn(async (input: SubmitCommandInput): Promise<CommandOperationResult> => {
			expect(input).toMatchObject({ command: "write config", sandboxPermissions: "full_access",
				justification: "Declared path /etc/config is outside the writable roots", expectedTarget: target });
			expect(sandboxApprovals.consume({ agentRunId: input.agentRunId!, sessionId: input.sessionId,
				toolCallId: input.toolCallId, command: input.command, justification: input.justification! }, target)).toBe(true);
			return { operation: { id: "operation", toolCallId: input.toolCallId, sessionId: input.sessionId,
				workspaceId: "workspace-1", command: input.command, status: "completed", timeoutMs: 1000,
				queueDeadlineAt: 1000, createdAt: 1, outputBytes: 0, outputTruncated: false }, outputTail: "written" };
		});
		context.createRemoteTool.mockReturnValue(createRemoteServerCallTool({ sessionId: commandRun.sessionId,
			agentRunId: commandRun.id, operations: { submit } }));
		const runtime = await context.factory.create({ run: commandRun, model: context.model,
			workDir: process.cwd(), history: [], systemPrompt: "command mode" });
		context.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "write config", write_paths: ["/etc/config"] },
				{ id: "exception" }), { stopReason: "toolUse" }),
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", isError: false });
				expect(JSON.stringify(providerContext.messages)).not.toContain("executionContext");
				return fauxAssistantMessage("Updated config.");
			},
		]);
		try {
			await runtime.prompt({ role: "user", content: "Update config", timestamp: 1 });
			expect(approvals.request).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: false,
				toolName: "remote_sandbox_exception" }), expect.any(AbortSignal));
			expect(submit).toHaveBeenCalledOnce();
			expect(runtime.publicFailure).toBeUndefined();
		} finally { await runtime.dispose(); }
	});

	it("sends a wrong-mode tool error to the model and executes its corrected call", async () => {
		const authorization = new ChatToolAuthorizationPolicy({
			sessions: { findById: vi.fn(async () => session) },
			terminalInteractions: { preflightSubmit: vi.fn(async () => ({ allowed: true })), approve: vi.fn(), reject: vi.fn() },
			preflightRemoteGuard: vi.fn(async () => ({ allowed: true })),
		});
		const approvals = { request: vi.fn(async () => ({ approved: true as const, source: "user" as const })) };
		const toolCalls = new ChatToolCallCoordinator({ authorization, approvals });
		const context = createContext({ toolCalls });
		const observe = vi.fn(async () => ({ content: [{ type: "text" as const, text: "terminal output" }], details: {} }));
		context.createTerminalTool.mockReturnValue({ ...terminalInteractionDefinition, execute: observe });
		const runtime = await context.factory.create({
			run: { ...commandRun, serverInteractionMode: "terminal", terminalSessionId: "terminal-1" },
			model: context.model, workDir: process.cwd(), history: [], systemPrompt: "terminal mode",
		});
		context.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "uname -a", timeoutMs: 30 }, { id: "wrong-mode" }), { stopReason: "toolUse" }),
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "wrong-mode", isError: true,
					content: [{ type: "text", text: "remote_server_call is unavailable in the current server interaction mode" }] });
				return fauxAssistantMessage(fauxToolCall("terminal_interaction", { action: "observe", expectation: "finite" }, { id: "corrected" }), { stopReason: "toolUse" });
			},
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "corrected", isError: false,
					content: [{ type: "text", text: "terminal output" }] });
				return fauxAssistantMessage("Recovered using the current terminal.");
			},
		]);
		try {
			await runtime.prompt({ role: "user", content: "Trigger a remote tool error", timestamp: 1 });
			expect(context.faux.state.callCount).toBe(3);
			expect(observe).toHaveBeenCalledOnce();
			expect(context.createRemoteTool).not.toHaveBeenCalled();
			expect(approvals.request).not.toHaveBeenCalled();
			expect(runtime.publicFailure).toBeUndefined();
			expect(context.getAgent()?.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop",
				content: [{ type: "text", text: "Recovered using the current terminal." }] });
		} finally {
			await runtime.dispose();
		}
	});

	it.each([false, true])("lets the model regenerate contradictory Terminal arguments without sending CTRL_C, autoAudit=%s", async (autoAudit) => {
		const interactions = {
			preflightSubmit: vi.fn(async () => ({ allowed: true })), approve: vi.fn(), reject: vi.fn(),
			execute: vi.fn(async () => ({
				interaction: { id: "interaction-1", expectation: "finite" },
				observation: { id: "observation-1", terminalSessionId: "terminal-1", agentViewText: "/srv/app",
					kind: "transcript", boundaryReason: "quiet", startSequence: 1, endSequence: 2, truncated: false },
			})),
			markDelivered: vi.fn(async () => undefined),
		};
		const authorization = new ChatToolAuthorizationPolicy({
			sessions: { findById: vi.fn(async () => ({ ...session, autoAudit })) },
			terminalInteractions: interactions,
			preflightRemoteGuard: vi.fn(async () => ({ allowed: true })),
		});
		const approvals = { request: vi.fn(async () => ({ approved: true as const, source: "user" as const })) };
		const context = createContext({ toolCalls: new ChatToolCallCoordinator({ authorization, approvals }) });
		context.createTerminalTool.mockReturnValue(createTerminalInteractionTool({
			sessionId: "session-1", terminalSessionId: "terminal-1", agentRunId: "run-1",
			interactions: interactions as unknown as TerminalInteractionService,
			sandbox: { mode: "full_access", backend: "none", enforcement: "none", source: "session_setting", configuredAt: 1 },
		}));
		const runtime = await context.factory.create({
			run: { ...commandRun, serverInteractionMode: "terminal", terminalSessionId: "terminal-1" },
			model: context.model, workDir: process.cwd(), history: [], systemPrompt: "terminal mode",
		});
		context.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("terminal_interaction", {
				action: "key", key: "CTRL_C", input: "pwd", expectation: "finite",
			}, { id: "conflicting" }), { stopReason: "toolUse" }),
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "conflicting", isError: true,
					content: [{ type: "text", text: expect.stringContaining('action="key" does not accept input') }] });
				expect(JSON.stringify(providerContext.messages.at(-1))).toContain("Regenerate the tool call");
				expect(interactions.execute).not.toHaveBeenCalled();
				expect(interactions.preflightSubmit).not.toHaveBeenCalled();
				expect(approvals.request).not.toHaveBeenCalled();
				return fauxAssistantMessage(fauxToolCall("terminal_interaction", {
					action: "submit", input: "pwd", expectation: "finite",
				}, { id: "corrected" }), { stopReason: "toolUse" });
			},
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "corrected", isError: false });
				return fauxAssistantMessage("Command submitted successfully.");
			},
		]);
		try {
			await runtime.prompt({ role: "user", content: "Run pwd", timestamp: 1 });
			expect(context.faux.state.callCount).toBe(3);
			expect(interactions.execute).toHaveBeenCalledOnce();
			expect(interactions.execute).toHaveBeenCalledWith(expect.objectContaining({
				toolCallId: "corrected", action: { type: "submit", input: "pwd" },
			}), expect.any(AbortSignal));
			expect(interactions.preflightSubmit).toHaveBeenCalledOnce();
			expect(interactions.approve).toHaveBeenCalledWith("run-1", "corrected");
			expect(interactions.markDelivered).toHaveBeenCalledOnce();
			expect(approvals.request).toHaveBeenCalledOnce();
			expect(approvals.request).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: autoAudit }), expect.any(AbortSignal));
			expect(runtime.publicFailure).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});

	it("returns invalid sandbox paths to the model and approves only its corrected call", async () => {
		const target = { defaultCwd: "/srv/app" } as SshTargetSnapshot;
		const probe = vi.fn(async () => ({ mode: "workspace_write" as const, backend: "landlock" as const,
			enforcement: "full" as const, sandboxRoot: "/srv/app", abi: 5, launcherVersion: "3" }));
		const authorization = new ChatToolAuthorizationPolicy({
			sessions: { findById: vi.fn(async () => session) },
			terminalInteractions: { preflightSubmit: vi.fn(async () => ({ allowed: true })), approve: vi.fn(), reject: vi.fn() },
			preflightRemoteGuard: vi.fn(async () => ({ allowed: true })),
			assessRemoteSandbox: async (_sessionId, declaredWritePaths, signal) => ({ target,
				route: await evaluateRemoteSandboxRoute({ sandbox: { getCapabilities: probe }, target, signal, declaredWritePaths }) }),
		});
		const approvals = { request: vi.fn(async () => ({ approved: true as const, source: "user" as const })) };
		const context = createContext({ toolCalls: new ChatToolCallCoordinator({ authorization, approvals }) });
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }], details: {} }));
		context.createRemoteTool.mockReturnValue({ ...remoteServerCallDefinition, execute });
		const runtime = await context.factory.create({ run: commandRun, model: context.model,
			workDir: process.cwd(), history: [], systemPrompt: "command mode" });
		context.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "touch /srv/app/output",
				write_paths: ["output"] }, { id: "relative-path" }), { stopReason: "toolUse" }),
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "relative-path", isError: true,
					content: [{ type: "text", text: "Declared remote write paths must be absolute Linux paths without NUL or newline" }] });
				expect(execute).not.toHaveBeenCalled();
				expect(approvals.request).not.toHaveBeenCalled();
				expect(probe).not.toHaveBeenCalled();
				return fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "touch /srv/app/output",
					write_paths: ["/srv/app/output"] }, { id: "absolute-path" }), { stopReason: "toolUse" });
			},
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "absolute-path", isError: false });
				return fauxAssistantMessage("Recovered with an absolute path.");
			},
		]);
		try {
			await runtime.prompt({ role: "user", content: "Write output", timestamp: 1 });
			expect(context.faux.state.callCount).toBe(3);
			expect(execute).toHaveBeenCalledOnce();
			expect(execute).toHaveBeenCalledWith("absolute-path", expect.objectContaining({ write_paths: ["/srv/app/output"] }),
				expect.any(AbortSignal), expect.any(Function), expect.any(RemoteCommandExecutionPlan));
			expect(approvals.request).toHaveBeenCalledOnce();
			expect(probe).toHaveBeenCalledOnce();
			expect(runtime.publicFailure).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});

	it("uses the same recoverable contract for request errors escaping the authorization coordinator", async () => {
		const beforeToolCall = vi.fn(async () => { throw sandboxFailure("invalid_request", "Correct the request"); });
		const context = createContext({ toolCalls: { beforeToolCall,
			requestSftpOverwriteApproval: vi.fn(async () => ({ approved: true as const, source: "user" as const })) } });
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		context.createRemoteTool.mockReturnValue({ ...remoteServerCallDefinition, execute });
		const runtime = await context.factory.create({ run: commandRun, model: context.model,
			workDir: process.cwd(), history: [], systemPrompt: "command mode" });
		context.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "pwd" }), { stopReason: "toolUse" }),
			(providerContext) => {
				expect(providerContext.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true,
					content: [{ type: "text", text: "Correct the request" }] });
				return fauxAssistantMessage("Request rejected; I can adjust it.");
			},
		]);
		try {
			await runtime.prompt({ role: "user", content: "Inspect", timestamp: 1 });
			expect(context.faux.state.callCount).toBe(2);
			expect(execute).not.toHaveBeenCalled();
			expect(runtime.publicFailure).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});

	it.each([
		sandboxFailure("sandbox_probe_failed", "Remote state is uncertain"),
		new Error("Approval storage failed"),
	])("keeps infrastructure authorization errors fatal: %s", async (failure) => {
		const approvals = { request: vi.fn(async () => ({ approved: true as const, source: "user" as const })) };
		const authorization = new ChatToolAuthorizationPolicy({
			sessions: { findById: vi.fn(async () => session) },
			terminalInteractions: { preflightSubmit: vi.fn(async () => ({ allowed: true })), approve: vi.fn(), reject: vi.fn() },
			preflightRemoteGuard: vi.fn(async () => ({ allowed: true })),
			assessRemoteSandbox: vi.fn(async () => { throw failure; }),
		});
		const context = createContext({ toolCalls: new ChatToolCallCoordinator({ authorization, approvals }) });
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		context.createRemoteTool.mockReturnValue({ ...remoteServerCallDefinition, execute });
		const runtime = await context.factory.create({ run: commandRun, model: context.model,
			workDir: process.cwd(), history: [], systemPrompt: "command mode" });
		context.faux.setResponses([fauxAssistantMessage(fauxToolCall("remote_server_call", { command: "pwd" }), { stopReason: "toolUse" })]);
		try {
			await runtime.prompt({ role: "user", content: "Inspect", timestamp: 1 });
			expect(context.faux.state.callCount).toBe(1);
			expect(execute).not.toHaveBeenCalled();
			expect(approvals.request).not.toHaveBeenCalled();
			expect(runtime.publicFailure).toBeDefined();
			expect(context.getAgent()?.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		} finally {
			await runtime.dispose();
		}
	});

	it.each([
		["remote_server_call", "terminal"], ["bubblewrap_inspect", "terminal"],
		["bubblewrap_install", "terminal"], ["terminal_interaction", "command"],
	] as const)("checks %s availability before authorization and direct execution in %s mode", async (toolName, mode) => {
		const beforeToolCall = vi.fn(async () => undefined);
		const context = createContext({ toolCalls: { beforeToolCall,
			requestSftpOverwriteApproval: vi.fn(async () => ({ approved: true as const, source: "user" as const })) } });
		const runtime = await context.factory.create({ run: { ...commandRun, serverInteractionMode: mode,
			terminalSessionId: mode === "terminal" ? "terminal-1" : null }, model: context.model,
			workDir: process.cwd(), history: [], systemPrompt: "mode" });
		try {
			const tool = context.getAgentOptions()!.initialState!.tools!.find((tool) => tool.name === toolName)!;
			expect(() => tool.prepareArguments?.({})).toThrowError(expect.objectContaining({ terminate: false,
				message: `${toolName} is unavailable in the current server interaction mode` }));
			await expect(tool.execute("call", {}, undefined)).rejects.toMatchObject({ terminate: false });
			expect(beforeToolCall).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});

	it.each([
		{ deploymentPlanning: { discussionId: "discussion-1", revision: 1 } },
		{ deploymentRunId: "deploy-1" },
		{ deploymentRunId: "deploy-1", deploymentRecovery: true },
	])("enforces deployment tool conflicts at the tool boundary: %j", async (binding) => {
		const beforeToolCall = vi.fn(async () => undefined);
		const context = createContext({ toolCalls: { beforeToolCall,
			requestSftpOverwriteApproval: vi.fn(async () => ({ approved: true as const, source: "user" as const })) } });
		const runtime = await context.factory.create({ run: { ...commandRun, serverInteractionMode: "terminal", terminalSessionId: "terminal-1" },
			model: context.model, workDir: process.cwd(), history: [], systemPrompt: "deployment", ...binding });
		try {
			const tools = context.getAgentOptions()!.initialState!.tools!;
			for (const name of ["sftp_upload", "sftp_download", "bubblewrap_inspect", "bubblewrap_install"]) {
				const tool = tools.find((tool) => tool.name === name)!;
				expect(() => tool.prepareArguments?.({})).toThrowError(expect.objectContaining({ terminate: false }));
				await expect(tool.execute("call", {}, undefined)).rejects.toMatchObject({ terminate: false });
			}
			const terminal = tools.find((tool) => tool.name === "terminal_interaction")!;
			const key = { action: "key", key: "CTRL_C", expectation: "finite" };
			expect(() => terminal.prepareArguments?.(key)).toThrowError(expect.objectContaining({ terminate: false }));
			await expect(terminal.execute("key", key, undefined)).rejects.toMatchObject({ terminate: false });
			for (const action of ["observe", "submit"]) {
				expect(() => terminal.prepareArguments?.({ action, input: "pwd", expectation: "finite" })).not.toThrow();
			}
			expect(beforeToolCall).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});

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
			maxRetries: 3,
			sessionId: "session-1",
			headers: {
				"x-existing-header": "preserved",
				"x-opencode-session": "session-1",
				"x-opencode-client": "pi",
			},
		});
		await runtime.dispose();
	});

	it("enables bounded retries while preserving request options for other providers", async () => {
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
		const signal = new AbortController().signal;
		const requestOptions: SimpleStreamOptions = {
			headers: { "x-existing-header": "preserved" }, signal, maxRetries: 10, maxRetryDelayMs: 5_000,
		};
		const streamFn = context.getAgentOptions()?.streamFn;
		if (!streamFn) throw new Error("Agent stream function was not configured");

		await streamFn(context.model, providerContext, requestOptions);

		expect(streamSimple).toHaveBeenCalledWith(context.model, providerContext, { ...requestOptions, maxRetries: 3 });
		expect(requestOptions.maxRetries).toBe(10);
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
			"bubblewrap_inspect",
			"bubblewrap_install",
			"ask_user_decision",
			"deployment_inspect",
			"deployment_execute_next",
			"deployment_propose_recovery",
			"deployment_propose_plan",
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
		const deployTool = options?.initialState?.tools?.find((tool) => tool.name === "deployment_execute_next");
		await expect(deployTool?.execute("deploy-call", { stage: "build" }, undefined)).rejects.toThrow("current Chat workflow");
		const planningTool = options?.initialState?.tools?.find((tool) => tool.name === "deployment_propose_plan");
		await expect(planningTool?.execute("proposal-call", {}, undefined)).rejects.toThrow("current Chat workflow");
		expect(context.createRemoteTool).toHaveBeenCalledWith("session-1", expect.any(Function), "run-1");
		expect(context.createTerminalTool).not.toHaveBeenCalled();

		const abort = vi.spyOn(context.getAgent()!, "abort");
		context.getRemoteAbort()?.();
		expect(abort).toHaveBeenCalledOnce();
		await runtime.dispose();
	});

	it("exposes the proposal tool only to a discussion-bound planning Run", async () => {
		const proposed: DeploymentRun = {
			id: "deploy-1", sessionId: "session-1", workspaceId: "workspace-1", createdAt: 1, updatedAt: 1, status: "preparing",
			plan: {
				profilePath: "/project/.gori/deploy-host.md", profileHash: "hash", project: "project",
				remoteAccess: { mode: "workspace_write" }, target: { host: "host" },
				targetBinding: { port: 22, hostKeyFingerprint: "fingerprint", credentialId: "credential", credentialAuthVersion: 1, remoteUser: "user", writableRoot: "/srv/project" },
				module: { id: "api", name: "API" }, build: { cwd: "/project", command: "build", artifact: "/project/api.jar" },
				upload: { remotePath: "/srv/project/api.jar" }, restart: { command: "restart" },
			},
			stages: {
				prepare: { status: "success", log: "" }, build: { status: "pending", log: "" },
				upload: { status: "pending", log: "" }, restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" },
			},
		};
		const proposeForDiscussion = vi.fn(async () => proposed);
		const deployments: AgentDeploymentService = {
			activeDiscussion: vi.fn(() => null), getDiscussion: vi.fn(() => { throw new Error("unused"); }),
			bindPlanningRun: vi.fn(async () => { throw new Error("unused"); }),
			discussionInstructions: vi.fn(async () => "instructions"), proposeForDiscussion,
			get: vi.fn(() => proposed), claimForAgent: vi.fn(async () => proposed),
			bindRecoveryAgent: vi.fn(async () => proposed), proposeRecoveryForAgent: vi.fn(async () => proposed),
			executeStageForAgent: vi.fn(async () => proposed), finishAgent: vi.fn(async () => undefined),
			finishPlanningAgent: vi.fn(async () => undefined),
		};
		const context = createContext({ deployments });
		const runtime = await context.factory.create({
			run: commandRun, model: context.model, workDir: process.cwd(), history: [], systemPrompt: "planning",
			deploymentPlanning: { discussionId: "discussion-1", revision: 2 },
		});
		try {
			const proposalTool = context.getAgentOptions()?.initialState?.tools?.find((tool) => tool.name === "deployment_propose_plan");
			const proposal = { buildSteps: [{ workdir: ".", command: "build" }], artifacts: [{ source: "api.jar", target: "/srv/project/api.jar" }], restart: { command: "restart" } };
			const signal = new AbortController().signal;
			await proposalTool?.execute("call-1", proposal, signal);
			expect(proposeForDiscussion).toHaveBeenCalledWith("session-1", "discussion-1", 2, "run-1", proposal, signal);
			const executeTool = context.getAgentOptions()?.initialState?.tools?.find((tool) => tool.name === "deployment_execute_next");
			await expect(executeTool?.execute("call-2", { stage: "build" }, undefined)).rejects.toThrow("current Chat workflow");
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects a Runtime that is bound to planning and execution at the same time", async () => {
		const context = createContext();
		await expect(context.factory.create({
			run: commandRun, model: context.model, workDir: process.cwd(), history: [], systemPrompt: "invalid",
			deploymentRunId: "deploy-1", deploymentPlanning: { discussionId: "discussion-1", revision: 2 },
		})).rejects.toMatchObject({ code: "chat_workflow_invalid" });
		expect(context.getAgentOptions()).toBeUndefined();
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
			"bubblewrap_inspect",
			"bubblewrap_install",
			"ask_user_decision",
			"deployment_inspect",
			"deployment_execute_next",
			"deployment_propose_recovery",
			"deployment_propose_plan",
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
			decisions: { request: vi.fn(async () => [{ kind: "skipped" as const }]) },
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
