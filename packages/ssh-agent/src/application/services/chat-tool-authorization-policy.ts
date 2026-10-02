import type { ChatRun } from "../../domain/chat.ts";
import type { TerminalObservationExpectation } from "../../domain/terminal.ts";
import { backendMessage, type BackendMessageDescriptor } from "../../i18n/message.ts";
import type { FullAccessRequest, RemoteSandboxApprovalStore } from "./remote-sandbox-approval-store.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import { type TerminalInteractionParameters, terminalInteractionAction } from "../tools/terminal-interaction-tool.ts";
import type { TerminalInteractionRequest, TerminalInteractionService } from "./terminal-interaction-service.ts";

export type PreparedToolAuthorization =
	| { readonly kind: "allow" }
	| { readonly kind: "defer_to_tool" }
	| { readonly kind: "block"; readonly block: true; readonly reason: string; readonly terminate: true }
	| {
			readonly kind: "approval";
			readonly autoApprove: boolean;
			readonly remoteFullAccess?: FullAccessRequest;
			readonly descriptionMessage?: BackendMessageDescriptor;
			readonly terminalInteraction?: { readonly agentRunId: string; readonly toolCallId: string };
	  };

export class ChatToolAuthorizationPolicy {
	readonly #deploymentRuns = new Set<string>();
	readonly #sandboxApprovals?: RemoteSandboxApprovalStore;
	readonly #sessions: Pick<SessionRepository, "findById">;
	readonly #terminalInteractions: Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;
	readonly #preflightRemoteGuard: (
		sessionId: string,
		command: string,
	) => Promise<{ allowed: boolean; reason?: string }>;

	constructor(options: {
		sessions: Pick<SessionRepository, "findById">;
		sandboxApprovals?: RemoteSandboxApprovalStore;
		terminalInteractions: Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;
		preflightRemoteGuard(sessionId: string, command: string): Promise<{ allowed: boolean; reason?: string }>;
	}) {
		this.#sessions = options.sessions;
		this.#sandboxApprovals = options.sandboxApprovals;
		this.#terminalInteractions = options.terminalInteractions;
		this.#preflightRemoteGuard = options.preflightRemoteGuard;
	}

	async prepare(input: {
		run: ChatRun;
		toolCallId: string;
		toolName: string;
		args: unknown;
	}): Promise<PreparedToolAuthorization> {
		const deploymentRun = this.#deploymentRuns.has(input.run.id);
		if (
			(input.toolName === "remote_server_call" && input.run.serverInteractionMode !== "command") ||
			(input.toolName === "terminal_interaction" && input.run.serverInteractionMode !== "terminal")
		) {
			return {
				kind: "block", block: true, terminate: true,
				reason: `${input.toolName} is unavailable in the current server interaction mode`,
			};
		}
		if (input.toolName === "read" || input.toolName === "ask_user_decision" ||
			input.toolName === "deployment_inspect" || input.toolName === "deployment_execute_next") return { kind: "allow" };
		if (input.toolName === "sftp_upload" || input.toolName === "sftp_download") {
			if (deploymentRun) return {
				kind: "block", block: true, terminate: true,
				reason: "SFTP tools are unavailable during deployment execution; use the confirmed deployment stage",
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
				return { kind: "approval", autoApprove: false,
					remoteFullAccess: { agentRunId: input.run.id, sessionId: input.run.sessionId, toolCallId: input.toolCallId,
						command: remoteCommandFrom(args), cwd: typeof args.cwd === "string" ? args.cwd : undefined,
						timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined, justification: args.justification },
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
					reason: "Terminal control keys are unavailable during deployment execution",
				};
				return { kind: "allow" };
			}
		}
		const session = await this.#sessions.findById(input.run.sessionId);
		const autoApprove =
			!deploymentRun &&
			session?.autoAudit === true &&
			(input.toolName === "write" ||
				input.toolName === "bash" ||
				input.toolName === "remote_server_call" ||
				terminalInteraction?.action.type === "submit");
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

	bindDeploymentRun(runId: string): void { this.#deploymentRuns.add(runId); }

	clearRun(runId: string): void {
		this.#deploymentRuns.delete(runId);
		this.#sandboxApprovals?.clearRun(runId);
	}

	async shouldAutoApproveSftpOverwrite(sessionId: string): Promise<boolean> {
		return (await this.#sessions.findById(sessionId))?.autoAudit === true;
	}

	recordDecision(prepared: PreparedToolAuthorization, approved: boolean): void {
		if (prepared.kind !== "approval") return;
		if (prepared.remoteFullAccess && approved && !prepared.autoApprove) this.#sandboxApprovals?.approve(prepared.remoteFullAccess);
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
