import type { ChatRun } from "../../domain/chat.ts";
import type { TerminalObservationExpectation } from "../../domain/terminal.ts";
import { backendMessage, type BackendMessageDescriptor } from "../../i18n/message.ts";
import type { FullAccessRequest, RemoteSandboxApprovalStore } from "./remote-sandbox-approval-store.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import { type TerminalInteractionParameters, terminalInteractionAction } from "../tools/terminal-interaction-tool.ts";
import type { TerminalInteractionRequest, TerminalInteractionService } from "./terminal-interaction-service.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { BUBBLEWRAP_INSTALL_JUSTIFICATION, BUBBLEWRAP_INSTALL_TIMEOUT_MS, bubblewrapInstallCommand,
	parseBubblewrapInstallPlan } from "./bubblewrap-installation-service.ts";
import type { RemoteSandboxRoute } from "./remote-sandbox-routing.ts";

const SANDBOX_EXCEPTION_TOOL_NAME = "remote_sandbox_exception";

export type PreparedToolAuthorization =
	| { readonly kind: "allow" }
	| { readonly kind: "defer_to_tool" }
	| { readonly kind: "block"; readonly block: true; readonly reason: string; readonly terminate: true }
	| {
			readonly kind: "approval";
			readonly autoApprove: boolean;
			readonly remoteFullAccess?: FullAccessRequest;
			readonly remoteFullAccessTarget?: SshTargetSnapshot;
			readonly approvalToolName?: string;
			readonly descriptionMessage?: BackendMessageDescriptor;
			readonly terminalInteraction?: { readonly agentRunId: string; readonly toolCallId: string };
	  };

export class ChatToolAuthorizationPolicy {
	readonly #deploymentRuns = new Set<string>();
	readonly #deploymentRunIds = new Map<string, string>();
	readonly #sandboxApprovals?: RemoteSandboxApprovalStore;
	readonly #sessions: Pick<SessionRepository, "findById">;
	readonly #terminalInteractions: Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;
	readonly #preflightRemoteGuard: (
		sessionId: string,
		command: string,
	) => Promise<{ allowed: boolean; reason?: string }>;
	readonly #requireBubblewrapInstallation?: (sessionId: string, signal: AbortSignal) => Promise<SshTargetSnapshot>;
	readonly #assessRemoteSandbox?: (sessionId: string, declaredWritePaths: readonly string[], signal: AbortSignal) =>
		Promise<{ readonly target: SshTargetSnapshot; readonly route: RemoteSandboxRoute }>;
	readonly #previewDeploymentRemoteStage?: (sessionId: string, deploymentRunId: string,
		stage: "restart" | "verify") => { readonly command: string; readonly mode: "workspace_write" | "full_access" } | undefined;
	readonly #resolveRemoteTarget?: (sessionId: string) => Promise<SshTargetSnapshot>;

	constructor(options: {
		sessions: Pick<SessionRepository, "findById">;
		sandboxApprovals?: RemoteSandboxApprovalStore;
		terminalInteractions: Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;
		preflightRemoteGuard(sessionId: string, command: string): Promise<{ allowed: boolean; reason?: string }>;
		requireBubblewrapInstallation?: (sessionId: string, signal: AbortSignal) => Promise<SshTargetSnapshot>;
		assessRemoteSandbox?: (sessionId: string, declaredWritePaths: readonly string[], signal: AbortSignal) =>
			Promise<{ readonly target: SshTargetSnapshot; readonly route: RemoteSandboxRoute }>;
		previewDeploymentRemoteStage?: (sessionId: string, deploymentRunId: string,
			stage: "restart" | "verify") => { readonly command: string; readonly mode: "workspace_write" | "full_access" } | undefined;
		resolveRemoteTarget?: (sessionId: string) => Promise<SshTargetSnapshot>;
	}) {
		this.#sessions = options.sessions;
		this.#sandboxApprovals = options.sandboxApprovals;
		this.#terminalInteractions = options.terminalInteractions;
		this.#preflightRemoteGuard = options.preflightRemoteGuard;
		this.#requireBubblewrapInstallation = options.requireBubblewrapInstallation;
		this.#assessRemoteSandbox = options.assessRemoteSandbox;
		this.#previewDeploymentRemoteStage = options.previewDeploymentRemoteStage;
		this.#resolveRemoteTarget = options.resolveRemoteTarget;
	}

	async prepare(input: {
		run: ChatRun;
		toolCallId: string;
		toolName: string;
		args: unknown;
		signal?: AbortSignal;
	}): Promise<PreparedToolAuthorization> {
		const deploymentRun = this.#deploymentRuns.has(input.run.id);
		if (
			(input.toolName === "remote_server_call" && input.run.serverInteractionMode !== "command") ||
			((input.toolName === "bubblewrap_inspect" || input.toolName === "bubblewrap_install") &&
				input.run.serverInteractionMode !== "command") ||
			(input.toolName === "terminal_interaction" && input.run.serverInteractionMode !== "terminal")
		) {
			return {
				kind: "block", block: true, terminate: true,
				reason: `${input.toolName} is unavailable in the current server interaction mode`,
			};
		}
		if (input.toolName === "bubblewrap_inspect") return deploymentRun
			? { kind: "block", block: true, terminate: true, reason: "Bubblewrap setup is unavailable during deployment" }
			: { kind: "allow" };
		if (input.toolName === "bubblewrap_install") {
			if (!this.#requireBubblewrapInstallation || deploymentRun) return {
				kind: "block", block: true, terminate: true, reason: "Bubblewrap installation is unavailable in this workflow",
			};
			const command = bubblewrapInstallCommand(parseBubblewrapInstallPlan(input.args));
			const target = await this.#requireBubblewrapInstallation(input.run.sessionId, input.signal ?? AbortSignal.timeout(30_000));
			const decision = await this.#preflightRemoteGuard(input.run.sessionId, command);
			if (!decision.allowed) return { kind: "block", block: true, terminate: true,
				reason: decision.reason ?? "Workspace Guard blocked Bubblewrap installation" };
			return {
				kind: "approval", autoApprove: false,
				remoteFullAccess: { agentRunId: input.run.id, sessionId: input.run.sessionId, toolCallId: input.toolCallId,
					command, cwd: "/", timeoutMs: BUBBLEWRAP_INSTALL_TIMEOUT_MS, justification: BUBBLEWRAP_INSTALL_JUSTIFICATION },
				remoteFullAccessTarget: target,
				descriptionMessage: backendMessage("approval.bubblewrap_install", { command }),
			};
		}
		if (input.toolName === "read" || input.toolName === "ask_user_decision" ||
			input.toolName === "deployment_inspect" ||
			input.toolName === "deployment_propose_plan" || input.toolName === "deployment_propose_recovery") return { kind: "allow" };
		if (input.toolName === "deployment_execute_next") {
			const stage = isRecord(input.args) ? input.args.stage : undefined;
			const deploymentRunId = this.#deploymentRunIds.get(input.run.id);
			if ((stage !== "restart" && stage !== "verify") || !deploymentRunId) return { kind: "allow" };
			const preview = this.#previewDeploymentRemoteStage?.(input.run.sessionId, deploymentRunId, stage);
			if (!preview || preview.mode === "full_access") return { kind: "allow" };
			const session = await this.#sessions.findById(input.run.sessionId);
			return { kind: "approval", autoApprove: session?.autoAudit === true,
				descriptionMessage: backendMessage("approval.deployment_sandboxed_command", { stage, command: preview.command }) };
		}
		if (input.toolName === "sftp_upload" || input.toolName === "sftp_download") {
			if (deploymentRun) return {
				kind: "block", block: true, terminate: true,
				reason: "SFTP tools are unavailable during deployment; use the confirmed deployment stage",
			};
			return { kind: "defer_to_tool" };
		}
		if (input.toolName === "remote_server_call") {
			const decision = await this.#preflightRemoteGuard(input.run.sessionId, remoteCommandFrom(input.args));
			if (!decision.allowed) {
				return {
					kind: "block",
					block: true,
					reason: decision.reason ?? "Command blocked by Workspace Guard",
					terminate: true,
				};
			}
			if (isRecord(input.args) && input.args.sandbox_permissions === "full_access") {
				const args = input.args;
				if (typeof args.justification !== "string" || !args.justification.trim()) {
					return { kind: "block", block: true, terminate: true, reason: "full_access requires a non-empty justification" };
				}
				const target = await this.#resolveRemoteTarget?.(input.run.sessionId);
				return { kind: "approval", autoApprove: false,
					approvalToolName: SANDBOX_EXCEPTION_TOOL_NAME,
					remoteFullAccess: { agentRunId: input.run.id, sessionId: input.run.sessionId, toolCallId: input.toolCallId,
						command: remoteCommandFrom(args), cwd: typeof args.cwd === "string" ? args.cwd : undefined,
						timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined, justification: args.justification },
					...(target === undefined ? {} : { remoteFullAccessTarget: target }),
					descriptionMessage: backendMessage("approval.remote_full_access", { justification: args.justification }),
				};
			}
		}
		let terminalInteraction: TerminalInteractionRequest | undefined;
		if (input.toolName === "terminal_interaction") {
			terminalInteraction = terminalRequest(input.run, input.toolCallId, terminalParametersFrom(input.args));
			if (terminalInteraction.action.type !== "submit") {
				if (deploymentRun && terminalInteraction.action.type === "key") return {
					kind: "block", block: true, terminate: true,
					reason: "Terminal control keys are unavailable during deployment",
				};
				return { kind: "allow" };
			}
		}
		const session = await this.#sessions.findById(input.run.sessionId);
		const autoApprove =
			session?.autoAudit === true &&
			(input.toolName === "write" ||
				input.toolName === "bash" ||
				input.toolName === "remote_server_call" ||
				terminalInteraction?.action.type === "submit");
		if (input.toolName === "remote_server_call" && isRecord(input.args)) {
			const declaredWritePaths = Array.isArray(input.args.write_paths) &&
				input.args.write_paths.every((path) => typeof path === "string")
				? input.args.write_paths as string[] : [];
			const assessed = await this.#assessRemoteSandbox?.(
				input.run.sessionId, declaredWritePaths, input.signal ?? AbortSignal.timeout(30_000),
			);
			if (assessed?.route.mode === "full_access") {
				const args = input.args;
				const reason = assessed.route.details;
				return {
					kind: "approval", autoApprove: false,
					approvalToolName: SANDBOX_EXCEPTION_TOOL_NAME,
					remoteFullAccess: { agentRunId: input.run.id, sessionId: input.run.sessionId, toolCallId: input.toolCallId,
						command: remoteCommandFrom(args), cwd: typeof args.cwd === "string" ? args.cwd : undefined,
						timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
						justification: reason },
					remoteFullAccessTarget: assessed.target,
					descriptionMessage: backendMessage("approval.remote_sandbox_exception", { reason }),
				};
			}
			return { kind: "approval", autoApprove, descriptionMessage: backendMessage("approval.remote_sandboxed_command") };
		}
		if (terminalInteraction?.action.type === "submit") {
			const decision = await this.#terminalInteractions.preflightSubmit(terminalInteraction, !autoApprove);
			if (!decision.allowed) {
				return {
					kind: "block",
					block: true,
					reason: decision.matchedRule?.reason ?? "Command blocked by Workspace Guard",
					terminate: true,
				};
			}
		}
		return {
			kind: "approval",
			autoApprove,
			...(terminalInteraction === undefined
				? {}
				: { terminalInteraction: { agentRunId: input.run.id, toolCallId: input.toolCallId } }),
		};
	}

	bindDeploymentRun(runId: string, deploymentRunId?: string): void {
		this.#deploymentRuns.add(runId);
		if (deploymentRunId !== undefined) this.#deploymentRunIds.set(runId, deploymentRunId);
	}

	clearRun(runId: string): void {
		this.#deploymentRuns.delete(runId);
		this.#deploymentRunIds.delete(runId);
		this.#sandboxApprovals?.clearRun(runId);
	}

	async shouldAutoApproveSftpOverwrite(sessionId: string): Promise<boolean> {
		return (await this.#sessions.findById(sessionId))?.autoAudit === true;
	}

	recordDecision(prepared: PreparedToolAuthorization, approved: boolean): void {
		if (prepared.kind !== "approval") return;
		if (prepared.remoteFullAccess && approved && !prepared.autoApprove)
			this.#sandboxApprovals?.approve(prepared.remoteFullAccess, prepared.remoteFullAccessTarget);
		if (prepared.terminalInteraction === undefined) return;
		if (approved) {
			this.#terminalInteractions.approve(
				prepared.terminalInteraction.agentRunId,
				prepared.terminalInteraction.toolCallId,
			);
		} else {
			this.#terminalInteractions.reject(
				prepared.terminalInteraction.agentRunId,
				prepared.terminalInteraction.toolCallId,
			);
		}
	}
}

function remoteCommandFrom(value: unknown): string {
	if (!isRecord(value) || typeof value.command !== "string") {
		throw new Error("remote_server_call requires a command");
	}
	return value.command;
}

function terminalParametersFrom(value: unknown): TerminalInteractionParameters {
	if (!isRecord(value) || !isExpectation(value.expectation)) {
		throw new Error("terminal_interaction parameters are invalid");
	}
	if (value.action === "submit" && typeof value.input === "string") {
		return { action: value.action, input: value.input, expectation: value.expectation };
	}
	if (value.action === "key" && value.key === "CTRL_C") {
		return { action: value.action, key: value.key, expectation: value.expectation };
	}
	if (value.action === "observe") return { action: value.action, expectation: value.expectation };
	throw new Error("terminal_interaction parameters are invalid");
}

function terminalRequest(
	run: ChatRun,
	toolCallId: string,
	params: TerminalInteractionParameters,
): TerminalInteractionRequest {
	if (run.terminalSessionId === null) {
		throw new Error("Terminal-mode Chat Run is missing its TerminalSession binding");
	}
	return {
		sessionId: run.sessionId,
		terminalSessionId: run.terminalSessionId,
		agentRunId: run.id,
		toolCallId,
		action: terminalInteractionAction(params),
		expectation: params.expectation,
	};
}

function isExpectation(value: unknown): value is TerminalObservationExpectation {
	return value === "finite" || value === "interactive" || value === "streaming";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
