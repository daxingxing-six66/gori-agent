import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import { prepareBubblewrapAuthorization } from "../tools/bubblewrap-installation-tool.ts";
import { prepareDeploymentStageAuthorization } from "../tools/deployment-agent-tool.ts";
import { prepareRemoteCommandAuthorization } from "../tools/remote-server-call-tool.ts";
import { prepareTerminalAuthorization } from "../tools/terminal-interaction-tool.ts";
import {
	authorizationFailure,
	type PreparedToolAuthorization,
	type ToolAuthorizationInput,
} from "../tools/tool-authorization.ts";
import type { RemoteSandboxApprovalStore } from "./remote-sandbox-approval-store.ts";
import type { RemoteSandboxRoute } from "./remote-sandbox-routing.ts";
import type { TerminalInteractionService } from "./terminal-interaction-service.ts";

export type { PreparedToolAuthorization } from "../tools/tool-authorization.ts";

interface ToolAuthorizationOptions {
	sessions: Pick<SessionRepository, "findById">;
	sandboxApprovals?: RemoteSandboxApprovalStore;
	terminalInteractions: Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;
	preflightRemoteGuard(sessionId: string, command: string): Promise<{ allowed: boolean; reason?: string }>;
	requireBubblewrapInstallation?: (sessionId: string, signal: AbortSignal) => Promise<SshTargetSnapshot>;
	assessRemoteSandbox?: (sessionId: string, declaredWritePaths: readonly string[], signal: AbortSignal) =>
		Promise<{ readonly target: SshTargetSnapshot; readonly route: RemoteSandboxRoute }>;
	previewDeploymentRemoteStage?: (sessionId: string, deploymentRunId: string, stage: "restart" | "verify") =>
		{ readonly command: string; readonly mode: "workspace_write" | "full_access" } | undefined;
	resolveRemoteTarget?: (sessionId: string) => Promise<SshTargetSnapshot>;
}

/** Dispatches tool-owned approval preparation; availability is checked by the bound Tool before this step. */
export class ChatToolAuthorizationPolicy {
	readonly #deploymentRunIds = new Map<string, string>();
	readonly #options: ToolAuthorizationOptions;

	constructor(options: ToolAuthorizationOptions) {
		this.#options = options;
	}

	async prepare(input: ToolAuthorizationInput): Promise<PreparedToolAuthorization> {
		try {
			return await this.#prepareTool(input);
		} catch (error) {
			const failure = authorizationFailure(error);
			if (failure) return failure;
			throw error;
		}
	}

	async #prepareTool(input: ToolAuthorizationInput): Promise<PreparedToolAuthorization> {
		const autoApprove = () => this.#autoApprove(input.run.sessionId);
		switch (input.toolName) {
			case "remote_server_call":
				return prepareRemoteCommandAuthorization(input, {
					autoApprove,
					preflightGuard: this.#options.preflightRemoteGuard,
					assessSandbox: this.#options.assessRemoteSandbox,
					resolveTarget: this.#options.resolveRemoteTarget,
				});
			case "terminal_interaction":
				return prepareTerminalAuthorization(input, { autoApprove, interactions: this.#options.terminalInteractions });
			case "bubblewrap_install":
				return prepareBubblewrapAuthorization(input, {
					requireInstallation: this.#options.requireBubblewrapInstallation,
					preflightGuard: this.#options.preflightRemoteGuard,
				});
			case "deployment_execute_next":
				return prepareDeploymentStageAuthorization(input, {
					autoApprove,
					deploymentRunId: this.#deploymentRunIds.get(input.run.id),
					previewRemoteStage: this.#options.previewDeploymentRemoteStage,
				});
			case "sftp_upload":
			case "sftp_download":
				return { kind: "defer_to_tool" };
			case "read":
			case "ask_user_decision":
			case "bubblewrap_inspect":
			case "deployment_inspect":
			case "deployment_propose_plan":
			case "deployment_propose_recovery":
				return { kind: "allow" };
			default:
				return {
					kind: "approval",
					autoApprove: (input.toolName === "write" || input.toolName === "bash") && await autoApprove(),
				};
		}
	}

	bindDeploymentRun(runId: string, deploymentRunId?: string): void {
		if (deploymentRunId !== undefined) this.#deploymentRunIds.set(runId, deploymentRunId);
	}

	clearRun(runId: string): void {
		this.#deploymentRunIds.delete(runId);
		this.#options.sandboxApprovals?.clearRun(runId);
	}

	shouldAutoApproveSftpOverwrite(sessionId: string): Promise<boolean> {
		return this.#autoApprove(sessionId);
	}

	async #autoApprove(sessionId: string): Promise<boolean> {
		return (await this.#options.sessions.findById(sessionId))?.autoAudit === true;
	}

	recordDecision(prepared: PreparedToolAuthorization, approved: boolean): void {
		if (prepared.kind !== "approval") return;
		if (prepared.remoteFullAccess && approved && !prepared.autoApprove)
			this.#options.sandboxApprovals?.approve(prepared.remoteFullAccess, prepared.remoteFullAccessTarget);
		prepared.onDecision?.(approved);
	}
}
