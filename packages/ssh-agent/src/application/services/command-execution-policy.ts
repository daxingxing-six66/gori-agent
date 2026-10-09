import type { CommandOperation } from "../../domain/command-operation.ts";
import type { Clock } from "../../domain/ids.ts";
import { sandboxFailure } from "../../domain/remote-sandbox.ts";
import { SshAgentError, type SshFailure } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { CommandGuardDecision, CommandGuardEvaluator } from "./command-guard-evaluator.ts";
import type { FullAccessRequest, RemoteSandboxApprovalStore } from "./remote-sandbox-approval-store.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";

export interface CommandExecutionTarget {
	readonly target: SshTargetSnapshot;
	readonly cwd: string;
}

export interface CommandGuardCheck {
	readonly decision: CommandGuardDecision;
	readonly failure?: SshFailure;
}

/** Execution-time checks. It consumes grants, but does not mutate Operation state or dispatch commands. */
export class CommandExecutionPolicy {
	private readonly targets: SshTargetResolver;
	private readonly guards: CommandGuardEvaluator;
	private readonly approvals: RemoteSandboxApprovalStore;
	private readonly clock: Clock;

	constructor(options: {
		targets: SshTargetResolver;
		guards: CommandGuardEvaluator;
		approvals: RemoteSandboxApprovalStore;
		clock: Clock;
	}) {
		this.targets = options.targets;
		this.guards = options.guards;
		this.approvals = options.approvals;
		this.clock = options.clock;
	}

	checkQueued(operation: Readonly<CommandOperation>, signal?: AbortSignal): SshFailure | undefined {
		// Loading the persisted Operation yields after the scheduler's final queue check.
		if (signal?.aborted) return commandQueueFailure("cancelled_before_dispatch");
		if (this.clock.now() >= operation.queueDeadlineAt) return commandQueueFailure("queue_timeout");
		return undefined;
	}

	async checkGuard(operation: Readonly<CommandOperation>): Promise<CommandGuardCheck> {
		const decision = await this.guards.evaluate(operation.workspaceId, operation.command);
		if (decision.allowed) return { decision };
		return { decision, failure: {
			code: "guard_blocked", category: "guard", phase: "guard_check",
			message: decision.matchedRule?.reason ?? "Workspace Guard blocked the command",
			retryable: false,
			...(decision.matchedRule ? { safeDetails: { ruleId: decision.matchedRule.id } } : {}),
		} };
	}

	async authorizeExecution(
		operation: Readonly<CommandOperation>,
		authorization: { readonly fullAccessRequest?: FullAccessRequest; readonly expectedTarget?: SshTargetSnapshot },
	): Promise<CommandExecutionTarget> {
		const target = await this.targets.resolve(operation.sessionId);
		if (operation.sandbox?.mode === "full_access" &&
			(!authorization.fullAccessRequest || !this.approvals.consume(authorization.fullAccessRequest, target))) {
			throw sandboxFailure("sandbox_approval_required", "full_access requires a new human approval for this exact tool call and SSH target. The command was not executed.");
		}
		if (authorization.expectedTarget && !sameExecutionTarget(target, authorization.expectedTarget)) {
			throw new SshAgentError({ code: "invalid_request", category: "request", phase: "validate",
				message: "Workspace SSH identity changed after approval. The command was not executed.", retryable: false });
		}
		return { target, cwd: requireCwd(operation.requestedCwd ?? target.defaultCwd) };
	}
}

export function commandQueueFailure(kind: "queue_timeout" | "cancelled_before_dispatch"): SshFailure {
	return {
		code: kind,
		category: "queue",
		phase: kind === "queue_timeout" ? "dispatch" : "cancel",
		message: kind === "queue_timeout"
			? "SSH command expired while waiting in the queue"
			: "SSH command was cancelled before dispatch",
		retryable: kind === "queue_timeout",
	};
}

function sameExecutionTarget(actual: SshTargetSnapshot, expected: SshTargetSnapshot): boolean {
	return actual.workspaceId === expected.workspaceId && actual.workspaceRevision === expected.workspaceRevision &&
		actual.hostname === expected.hostname && actual.port === expected.port &&
		actual.hostKeyAlgorithm === expected.hostKeyAlgorithm && actual.hostKeyFingerprint === expected.hostKeyFingerprint &&
		actual.credentialId === expected.credentialId && actual.credentialAuthVersion === expected.credentialAuthVersion &&
		actual.remoteUser === expected.remoteUser && actual.defaultCwd === expected.defaultCwd;
}

function requireCwd(value: string): string {
	const cwd = value.trim();
	if ((!cwd.startsWith("/") && cwd !== "~" && !cwd.startsWith("~/")) || cwd.includes("\0")) {
		throw new SshAgentError({ code: "invalid_request", category: "request", phase: "validate",
			message: "cwd must be an absolute Linux path or a path under the remote user's home directory", retryable: false });
	}
	return cwd;
}
