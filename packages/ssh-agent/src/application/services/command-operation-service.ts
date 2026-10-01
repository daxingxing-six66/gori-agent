import { Buffer } from "node:buffer";
import type {
	CommandOperation,
	CommandOperationStatus,
	OperationEvent,
	OperationEventData,
	OperationEventType,
} from "../../domain/command-operation.ts";
import { ACTIVE_COMMAND_OPERATION_STATUSES } from "../../domain/command-operation.ts";
import type { Clock, IdGenerator, OperationId, SessionId } from "../../domain/ids.ts";
import { normalizeSshFailure, SshAgentError, type SshFailure } from "../../domain/ssh-failure.ts";
import { sandboxFailure, type RemoteSandboxMode } from "../../domain/remote-sandbox.ts";
import type { RemoteSandboxProvider } from "./remote-sandbox-provider.ts";
import { RemoteSandboxApprovalStore, type FullAccessRequest } from "./remote-sandbox-approval-store.ts";
import { SandboxConfirmationCapture } from "./sandbox-confirmation-capture.ts";
import type { CommandOperationRepository } from "../repositories/command-operation-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { RemoteCommandBroker } from "../ssh-channel-broker.ts";
import type { CommandGuardDecision, CommandGuardEvaluator } from "./command-guard-evaluator.ts";
import { SessionCommandScheduler } from "./session-command-scheduler.ts";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";

export const COMMAND_EXECUTION_DEFAULTS = {
	queueTimeoutMs: 60_000,
	commandTimeoutMs: 300_000,
	maxCommandTimeoutMs: 1_800_000,
	maxConcurrentOperations: 16,
	persistedOutputLimitBytes: 10 * 1024 * 1024,
	llmOutputTailBytes: 64 * 1024,
} as const;

export interface SubmitCommandInput {
	toolCallId: string;
	sessionId: SessionId;
	command: string;
	agentRunId?: string;
	sandboxPermissions?: RemoteSandboxMode;
	justification?: string;
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onEvent?: (event: OperationEvent, operation: CommandOperation) => void;
	abortRun?: () => void;
}

export interface CommandOperationResult {
	operation: CommandOperation;
	outputTail: string;
}

interface PendingCommand {
	fullAccessRequest?: FullAccessRequest;
	operationId: OperationId;
	signal?: AbortSignal;
	onEvent?: (event: OperationEvent, operation: CommandOperation) => void;
	abortRun?: () => void;
}

export class CommandOperationService {
	private readonly operations: CommandOperationRepository;
	private readonly sessions: SessionRepository;
	private readonly targets: SshTargetResolver;
	private readonly guards: CommandGuardEvaluator;
	private readonly broker: RemoteCommandBroker;
	private readonly sandbox?: RemoteSandboxProvider;
	private readonly sandboxApprovals: RemoteSandboxApprovalStore;
	private readonly clock: Clock;
	private readonly ids: IdGenerator;
	private readonly lifecycle?: SessionLifecycleCoordinator;
	private readonly scheduler: SessionCommandScheduler<CommandOperationResult>;
	private closed = false;
	private ready: Promise<void>;

	constructor(options: {
		operations: CommandOperationRepository;
		sessions: SessionRepository;
		targets: SshTargetResolver;
		guards: CommandGuardEvaluator;
		broker: RemoteCommandBroker;
		sandbox?: RemoteSandboxProvider;
		sandboxApprovals?: RemoteSandboxApprovalStore;
		clock: Clock;
		ids: IdGenerator;
		lifecycle?: SessionLifecycleCoordinator;
		maxConcurrentOperations?: number;
	}) {
		this.operations = options.operations;
		this.sessions = options.sessions;
		this.targets = options.targets;
		this.guards = options.guards;
		this.broker = options.broker;
		this.sandbox = options.sandbox;
		this.sandboxApprovals = options.sandboxApprovals ?? new RemoteSandboxApprovalStore();
		this.clock = options.clock;
		this.ids = options.ids;
		this.lifecycle = options.lifecycle;
		this.scheduler = new SessionCommandScheduler({
			clock: options.clock,
			maxConcurrentOperations: options.maxConcurrentOperations ?? COMMAND_EXECUTION_DEFAULTS.maxConcurrentOperations,
		});
		this.ready = this.reconcileAfterRestart();
	}

	async submit(input: SubmitCommandInput): Promise<CommandOperationResult> {
		await this.ready;
		const command = requireCommand(input.command);
		const timeoutMs = requireTimeout(input.timeoutMs);
		const mode = input.sandboxPermissions ?? "workspace_write";
		if (mode !== "workspace_write" && mode !== "full_access") throw sandboxFailure("invalid_request", "Invalid sandbox permissions");
		if (mode === "full_access" && !input.justification?.trim()) throw sandboxFailure("invalid_request", "full_access requires a justification");
		if (this.closed) {
			return this.createRejectedResult(input, command, timeoutMs, {
				code: "queue_closed",
				category: "queue",
				phase: "enqueue",
				message: "SSH command queue is closed",
				retryable: false,
			});
		}
		const session = await this.sessions.findById(input.sessionId);
		if (!session) {
			return this.createRejectedResult(input, command, timeoutMs, {
				code: "session_not_found",
				category: "request",
				phase: "validate",
				message: "SSH session does not exist",
				retryable: false,
				sessionId: input.sessionId,
			});
		}
		const lease = this.lifecycle?.acquireUse(session.id, "command_operation");
		try {
			const now = this.clock.now();
			const operation: CommandOperation = {
				id: this.ids.next(),
				toolCallId: input.toolCallId,
				sessionId: session.id,
				workspaceId: session.workspaceId,
				command,
				agentRunId: input.agentRunId,
				sandbox: { mode, backend: "none", enforcement: "none", commandMayHaveRun: false },
				sandboxJustification: input.justification,
				...(input.cwd === undefined ? {} : { requestedCwd: input.cwd }),
				timeoutMs,
				status: "created",
				queueDeadlineAt: now + COMMAND_EXECUTION_DEFAULTS.queueTimeoutMs,
				outputBytes: 0,
				outputTruncated: false,
				createdAt: now,
			};
			await this.operations.insert(operation);
			await this.emit(operation, "status", { status: "created" }, input.onEvent);
			operation.status = "queued";
			operation.enqueuedAt = this.clock.now();
			await this.persistTransition(operation, ["created"]);
			await this.emit(operation, "status", { status: "queued" }, input.onEvent);
			const pending: PendingCommand = {
				operationId: operation.id,
				...(mode !== "full_access" ? {} : { fullAccessRequest: {
					agentRunId: input.agentRunId ?? "", toolCallId: input.toolCallId, sessionId: input.sessionId,
					command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs, justification: input.justification ?? "",
				} }),
				...(input.signal ? { signal: input.signal } : {}),
				...(input.onEvent ? { onEvent: input.onEvent } : {}),
				...(input.abortRun ? { abortRun: input.abortRun } : {}),
			};
			const scheduled = await this.scheduler.schedule({
				sessionId: operation.sessionId,
				deadlineAt: operation.queueDeadlineAt,
				...(input.signal ? { signal: input.signal } : {}),
				execute: () => this.executePending(pending),
			});
			if (scheduled.kind === "executed") return scheduled.result;
			const queuedOperation = await this.operations.findById(operation.id);
			if (!queuedOperation) throw new Error(`Command operation disappeared: ${operation.id}`);
			return this.finishFailure(
				queuedOperation,
				"cancelled",
				scheduled.kind === "queue_timeout"
					? {
							code: "queue_timeout",
							category: "queue",
							phase: "dispatch",
							message: "SSH command expired while waiting in the queue",
							retryable: true,
						}
					: {
							code: "cancelled_before_dispatch",
							category: "queue",
							phase: "cancel",
							message: "SSH command was cancelled before dispatch",
							retryable: false,
						},
				pending,
				new OutputTail(COMMAND_EXECUTION_DEFAULTS.llmOutputTailBytes),
			);
		} finally {
			lease?.release();
		}
	}

	async preflightGuard(sessionId: SessionId, command: string): Promise<CommandGuardDecision> {
		const session = await this.sessions.findById(sessionId);
		if (!session) throw new Error(`Session not found: ${sessionId}`);
		return this.guards.evaluate(session.workspaceId, requireCommand(command));
	}

	close(): void {
		this.closed = true;
	}

	private async executePending(pending: PendingCommand): Promise<CommandOperationResult> {
		const operation = await this.operations.findById(pending.operationId);
		if (!operation) throw new Error(`Command operation disappeared: ${pending.operationId}`);
		const tail = new OutputTail(COMMAND_EXECUTION_DEFAULTS.llmOutputTailBytes);
		if (pending.signal?.aborted) {
			return this.finishFailure(
				operation,
				"cancelled",
				{
					code: "cancelled_before_dispatch",
					category: "queue",
					phase: "cancel",
					message: "SSH command was cancelled before dispatch",
					retryable: false,
				},
				pending,
				tail,
			);
		}
		if (this.clock.now() > operation.queueDeadlineAt) {
			return this.finishFailure(
				operation,
				"cancelled",
				{
					code: "queue_timeout",
					category: "queue",
					phase: "dispatch",
					message: "SSH command expired while waiting in the queue",
					retryable: true,
				},
				pending,
				tail,
			);
		}
		operation.status = "dispatching";
		operation.claimedAt = this.clock.now();
		await this.persistTransition(operation, ["queued"]);
		await this.emit(operation, "status", { status: "dispatching" }, pending.onEvent);
		try {
			const decision = await this.guards.evaluate(operation.workspaceId, operation.command);
			operation.guardRevision = decision.guardRevision;
			if (!decision.allowed) {
				operation.matchedGuardRuleId = decision.matchedRule?.id;
				try {
					pending.abortRun?.();
				} catch {
					// A UI/run callback must not bypass a persisted Guard decision.
				}
				return await this.finishFailure(
					operation,
					"blocked",
					{
						code: "guard_blocked",
						category: "guard",
						phase: "guard_check",
						message: decision.matchedRule?.reason ?? "Workspace Guard blocked the command",
						retryable: false,
						operationId: operation.id,
						sessionId: operation.sessionId,
						workspaceId: operation.workspaceId,
						safeDetails: decision.matchedRule ? { ruleId: decision.matchedRule.id } : undefined,
					},
					pending,
					tail,
				);
			}
			if (operation.sandbox?.mode === "full_access" &&
				(!pending.fullAccessRequest || !this.sandboxApprovals.consume(pending.fullAccessRequest))) {
				throw sandboxFailure("sandbox_approval_required", "full_access requires a new human approval for this exact tool call. The command was not executed.");
			}
			const target = await this.targets.resolve(operation.sessionId);
			operation.executionContext = target;
			operation.resolvedCwd = requireCwd(operation.requestedCwd ?? target.defaultCwd);
			const controller = new AbortController();
			const abortFromCaller = () => controller.abort(pending.signal?.reason);
			pending.signal?.addEventListener("abort", abortFromCaller, { once: true });
			const timeout = setTimeout(
				() =>
					controller.abort(
						new SshAgentError({
							code: "execution_timeout",
							category: "execution",
							phase: "execute",
							message: "Remote command exceeded its execution timeout",
							retryable: false,
							operationId: operation.id,
						}),
					),
				operation.timeoutMs,
			);
			try {
				if (pending.signal?.aborted) controller.abort(pending.signal.reason);
				if (!this.sandbox) throw sandboxFailure("sandbox_unavailable", "Remote sandbox provider is unavailable. The command was not executed.");
				const prepared = await this.sandbox.prepare({ target, cwd: operation.resolvedCwd, command: operation.command,
					policy: { mode: operation.sandbox?.mode ?? "workspace_write" }, signal: controller.signal });
				controller.signal.throwIfAborted();
				const finalDecision = await this.guards.evaluate(operation.workspaceId, operation.command);
				operation.guardRevision = finalDecision.guardRevision;
				if (!finalDecision.allowed) {
					operation.matchedGuardRuleId = finalDecision.matchedRule?.id;
					try { pending.abortRun?.(); } catch { /* Guard remains authoritative. */ }
					return await this.finishFailure(operation, "blocked", {
						code: "guard_blocked", category: "guard", phase: "guard_check",
						message: finalDecision.matchedRule?.reason ?? "Workspace Guard blocked the command", retryable: false,
					}, pending, tail);
				}
				// Once dispatch can begin, lost SSH/output/persistence acknowledgements cannot prove the command did not run.
				operation.sandbox = { ...prepared.sandbox, enforcement: "none", commandMayHaveRun: true };
				operation.status = "running";
				operation.startedAt = this.clock.now();
				await this.persistTransition(operation, ["dispatching"]);
				await this.emit(operation, "status", { status: "running" }, pending.onEvent);
				const confirmation = new SandboxConfirmationCapture({
					marker: prepared.confirmation,
					onConfirmed: async () => {
						operation.sandbox = { ...prepared.sandbox, commandMayHaveRun: true };
						await this.persistTransition(operation, ["running"]);
					},
					onOutput: (chunk) => this.recordOutput(operation, "stderr", chunk, tail, pending.onEvent),
				});
				const result = await this.broker.execute({
					target,
					command: prepared.command,
					signal: controller.signal,
					onStdout: (chunk) => this.recordOutput(operation, "stdout", chunk, tail, pending.onEvent),
					onStderr: (chunk) => confirmation.write(chunk),
				});
				operation.exitCode = result.exitCode;
				operation.exitSignal = result.exitSignal;
				await confirmation.finish();
				if (!confirmation.confirmed) {
					operation.sandbox.commandMayHaveRun = true;
					throw new SshAgentError({ code: "sandbox_confirmation_missing", category: "sandbox", phase: "execute",
						message: "Remote confinement could not be confirmed. The command may have run; inspect its effects before another attempt.", retryable: false,
						safeDetails: { commandMayHaveRun: true } });
				}
				await this.emit(operation, "exit", result, pending.onEvent);
				if (result.exitSignal) {
					return await this.finishFailure(
						operation,
						"failed",
						{
							code: "exit_signal_received",
							category: "execution",
							phase: "execute",
							message: "Remote command exited because of a signal",
							retryable: false,
							safeDetails: { signal: result.exitSignal },
						},
						pending,
						tail,
					);
				}
				if (result.exitCode === undefined) throw new SshAgentError({ code: "execution_result_uncertain", category: "execution", phase: "execute", message: "Remote command returned no exit status", retryable: false });
				if (result.exitCode !== 0) {
					const denialSuspected = operation.sandbox.mode === "workspace_write" && /permission denied|operation not permitted/i.test(tail.text());
					operation.sandbox.denialSuspected = denialSuspected;
					return await this.finishFailure(
						operation,
						"failed",
						{
							code: denialSuspected ? "sandbox_denied" : "remote_exit_non_zero",
							category: "execution",
							phase: "execute",
							message: denialSuspected ? "A permission failure may be due to the sandbox. This attempt may have partial effects; inspect before requesting a new full_access approval." : "Remote command exited with a non-zero status",
							retryable: false,
							safeDetails: { exitCode: result.exitCode, commandMayHaveRun: true, denialSuspected },
						},
						pending,
						tail,
					);
				}
				operation.status = "completed";
				operation.finishedAt = this.clock.now();
				await this.persistTransition(operation, ["running"]);
				await this.emit(operation, "status", { status: "completed" }, pending.onEvent);
				return { operation, outputTail: tail.text() };
			} finally {
				clearTimeout(timeout);
				pending.signal?.removeEventListener("abort", abortFromCaller);
			}
		} catch (error) {
			const failure = normalizeSshFailure(error, {
				category: "internal",
				phase: "execute",
				retryable: false,
				operationId: operation.id,
				sessionId: operation.sessionId,
				workspaceId: operation.workspaceId,
			});
			const status =
				failure.code === "execution_result_uncertain"
					? "uncertain"
					: failure.code === "execution_cancelled"
						? "cancelled"
						: "failed";
			return this.finishFailure(operation, status, failure, pending, tail);
		}
	}

	private async recordOutput(
		operation: CommandOperation,
		type: "stdout" | "stderr",
		chunk: Uint8Array,
		tail: OutputTail,
		onEvent?: (event: OperationEvent, operation: CommandOperation) => void,
	): Promise<void> {
		operation.outputBytes += chunk.byteLength;
		tail.append(chunk);
		const remaining =
			COMMAND_EXECUTION_DEFAULTS.persistedOutputLimitBytes - (operation.outputBytes - chunk.byteLength);
		if (remaining > 0) {
			const persisted = chunk.subarray(0, Math.min(remaining, chunk.byteLength));
			await this.emit(operation, type, { chunk: Buffer.from(persisted).toString("utf8") }, onEvent);
		}
		if (!operation.outputTruncated && operation.outputBytes > COMMAND_EXECUTION_DEFAULTS.persistedOutputLimitBytes) {
			operation.outputTruncated = true;
			await this.emit(
				operation,
				"output_truncated",
				{ limitBytes: COMMAND_EXECUTION_DEFAULTS.persistedOutputLimitBytes },
				onEvent,
			);
		}
	}

	private async finishFailure(
		operation: CommandOperation,
		status: Extract<CommandOperationStatus, "failed" | "cancelled" | "blocked" | "uncertain">,
		failure: SshFailure,
		pending: Pick<PendingCommand, "onEvent">,
		tail: OutputTail,
	): Promise<CommandOperationResult> {
		const previous = operation.status;
		operation.status = status;
		operation.failure = {
			...failure,
			operationId: operation.id,
			sessionId: operation.sessionId,
			workspaceId: operation.workspaceId,
		};
		operation.finishedAt = this.clock.now();
		await this.persistTransition(operation, [previous]);
		await this.emit(operation, "status", { status }, pending.onEvent);
		return { operation, outputTail: tail.text() };
	}

	private async createRejectedResult(
		input: SubmitCommandInput,
		command: string,
		timeoutMs: number,
		failure: SshFailure,
	): Promise<CommandOperationResult> {
		const now = this.clock.now();
		const operation: CommandOperation = {
			id: this.ids.next(),
			toolCallId: input.toolCallId,
			sessionId: input.sessionId,
			workspaceId: "",
			command,
			timeoutMs,
			status: "failed",
			queueDeadlineAt: now,
			failure,
			outputBytes: 0,
			outputTruncated: false,
			createdAt: now,
			finishedAt: now,
		};
		return { operation, outputTail: "" };
	}

	private async persistTransition(
		operation: CommandOperation,
		expected: readonly CommandOperationStatus[],
	): Promise<void> {
		if (!(await this.operations.update(operation, expected))) {
			throw new SshAgentError({
				code: "operation_persistence_failed",
				category: "persistence",
				phase: "persist",
				message: "Command operation state could not be persisted",
				retryable: false,
				operationId: operation.id,
			});
		}
	}

	private async emit(
		operation: CommandOperation,
		type: OperationEventType,
		data: OperationEventData,
		onEvent?: (event: OperationEvent, operation: CommandOperation) => void,
	): Promise<void> {
		const event = await this.operations.appendEvent({
			operationId: operation.id,
			timestamp: this.clock.now(),
			type,
			data,
		});
		onEvent?.(event, operation);
	}

	private async reconcileAfterRestart(): Promise<void> {
		const active = await this.operations.listByStatuses(ACTIVE_COMMAND_OPERATION_STATUSES);
		for (const operation of active) {
			const previous = operation.status;
			if (previous === "running" && operation.sandbox) operation.sandbox.commandMayHaveRun = true;
			operation.status = previous === "running" ? "uncertain" : "cancelled";
			operation.failure = {
				code: previous === "running" ? "execution_result_uncertain" : "service_restarted_before_dispatch",
				category: previous === "running" ? "execution" : "queue",
				phase: previous === "running" ? "execute" : "dispatch",
				message:
					previous === "running"
						? "Service restarted while the remote command was running; the result is uncertain"
						: "Service restarted before the queued command could be dispatched",
				retryable: previous !== "running",
				operationId: operation.id,
				sessionId: operation.sessionId,
				workspaceId: operation.workspaceId,
			};
			operation.finishedAt = this.clock.now();
			await this.persistTransition(operation, [previous]);
			await this.emit(operation, "status", { status: operation.status });
		}
	}
}

function requireCommand(value: string): string {
	const command = value.trim();
	if (!command || command.includes("\0")) {
		throw new SshAgentError({
			code: "invalid_request",
			category: "request",
			phase: "validate",
			message: "command must not be empty",
			retryable: false,
		});
	}
	return command;
}

function requireTimeout(value?: number): number {
	const timeout = value ?? COMMAND_EXECUTION_DEFAULTS.commandTimeoutMs;
	if (!Number.isInteger(timeout) || timeout <= 0 || timeout > COMMAND_EXECUTION_DEFAULTS.maxCommandTimeoutMs) {
		throw new SshAgentError({
			code: "invalid_request",
			category: "request",
			phase: "validate",
			message: `timeoutMs must be an integer between 1 and ${COMMAND_EXECUTION_DEFAULTS.maxCommandTimeoutMs}`,
			retryable: false,
		});
	}
	return timeout;
}

function requireCwd(value: string): string {
	const cwd = value.trim();
	if ((!cwd.startsWith("/") && cwd !== "~" && !cwd.startsWith("~/")) || cwd.includes("\0")) {
		throw new SshAgentError({
			code: "invalid_request",
			category: "request",
			phase: "validate",
			message: "cwd must be an absolute Linux path or a path under the remote user's home directory",
			retryable: false,
		});
	}
	return cwd;
}

class OutputTail {
	private buffer = Buffer.alloc(0);
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	append(chunk: Uint8Array): void {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]).subarray(-this.limit);
	}

	text(): string {
		return this.buffer.toString("utf8");
	}
}
