import type { CommandOperation, OperationEvent } from "../../domain/command-operation.ts";
import { ACTIVE_COMMAND_OPERATION_STATUSES } from "../../domain/command-operation.ts";
import type { Clock, IdGenerator, OperationId, SessionId } from "../../domain/ids.ts";
import { normalizeSshFailure, SshAgentError, type SshFailure } from "../../domain/ssh-failure.ts";
import { sandboxFailure, type RemoteSandboxMode } from "../../domain/remote-sandbox.ts";
import type { PreparedRemoteExecution, RemoteSandboxProvider } from "./remote-sandbox-provider.ts";
import { RemoteSandboxApprovalStore, type FullAccessRequest } from "./remote-sandbox-approval-store.ts";
import { SandboxConfirmationCapture } from "./sandbox-confirmation-capture.ts";
import type { CommandOperationRepository } from "../repositories/command-operation-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { RemoteCommandBroker, RemoteExecutionResult } from "../ssh-channel-broker.ts";
import type { CommandGuardDecision, CommandGuardEvaluator } from "./command-guard-evaluator.ts";
import { SessionCommandScheduler } from "./session-command-scheduler.ts";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { CommandExecutionPolicy, commandQueueFailure, type CommandExecutionTarget } from "./command-execution-policy.ts";
import { CommandOperationRecorder, type CommandOperationResult } from "./command-operation-recorder.ts";

export type { CommandOperationResult } from "./command-operation-recorder.ts";

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
	/** In-process approval scope for non-Chat workflows; it is not persisted as a Chat Run ID. */
	fullAccessApprovalScopeId?: string;
	sandboxPermissions?: RemoteSandboxMode;
	justification?: string;
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onEvent?: (event: OperationEvent, operation: CommandOperation) => void;
	abortRun?: () => void;
	/** Reject queued execution if the approved Workspace SSH identity changes before dispatch. */
	expectedTarget?: SshTargetSnapshot;
}

interface PendingCommand {
	fullAccessRequest?: FullAccessRequest;
	operationId: OperationId;
	signal?: AbortSignal;
	onEvent?: (event: OperationEvent, operation: CommandOperation) => void;
	abortRun?: () => void;
	expectedTarget?: SshTargetSnapshot;
}

export class CommandOperationService {
	private readonly operations: CommandOperationRepository;
	private readonly sessions: SessionRepository;
	private readonly guards: CommandGuardEvaluator;
	private readonly broker: RemoteCommandBroker;
	private readonly sandbox?: RemoteSandboxProvider;
	private readonly executionPolicy: CommandExecutionPolicy;
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
		this.guards = options.guards;
		this.broker = options.broker;
		this.sandbox = options.sandbox;
		this.executionPolicy = new CommandExecutionPolicy({
			targets: options.targets,
			guards: options.guards,
			approvals: options.sandboxApprovals ?? new RemoteSandboxApprovalStore(),
			clock: options.clock,
		});
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
			await this.recorder(operation, input.onEvent).enqueue();
			const pending: PendingCommand = {
				operationId: operation.id,
				...(mode !== "full_access" ? {} : { fullAccessRequest: {
					agentRunId: input.fullAccessApprovalScopeId ?? input.agentRunId ?? "", toolCallId: input.toolCallId, sessionId: input.sessionId,
					command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs, justification: input.justification ?? "",
				} }),
				...(input.signal ? { signal: input.signal } : {}),
				...(input.onEvent ? { onEvent: input.onEvent } : {}),
				...(input.abortRun ? { abortRun: input.abortRun } : {}),
				...(input.expectedTarget ? { expectedTarget: input.expectedTarget } : {}),
			};
			const scheduled = await this.scheduler.schedule({
				sessionId: operation.sessionId,
				deadlineAt: operation.queueDeadlineAt,
				...(input.signal ? { signal: input.signal } : {}),
				execute: () => this.executePending(pending),
			});
			if (scheduled.kind === "executed") return scheduled.result;
			const queued = await this.loadRecorder(operation.id, input.onEvent);
			return queued.fail(commandQueueFailure(scheduled.kind));
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
		const record = await this.loadRecorder(pending.operationId, pending.onEvent);
		const operation = record.operation;
		const queueFailure = this.executionPolicy.checkQueued(operation, pending.signal);
		if (queueFailure) return record.fail(queueFailure);
		await record.markDispatching();
		try {
			await this.checkGuard(record, pending.abortRun);
			const execution = await this.executionPolicy.authorizeExecution(operation, pending);
			record.bindExecution(execution);
			return await this.withExecutionSignal(operation, pending.signal, async (signal) => {
				const prepared = await this.prepareCommand(operation, execution, signal);
				// Preparation can await remote probes; Guard may have changed in the meantime.
				await this.checkGuard(record, pending.abortRun);
				return this.executeCommand(record, execution.target, prepared, signal);
			});
		} catch (error) {
			return record.fail(normalizeSshFailure(error, {
				category: "internal", phase: "execute", retryable: false,
			}));
		}
	}

	private async checkGuard(record: CommandOperationRecorder, abortRun?: () => void): Promise<void> {
		const check = await this.executionPolicy.checkGuard(record.operation);
		record.recordGuard(check.decision);
		if (!check.failure) return;
		try { abortRun?.(); } catch { /* A callback must not bypass the Guard decision. */ }
		throw new SshAgentError(check.failure);
	}

	private async prepareCommand(
		operation: CommandOperation,
		execution: CommandExecutionTarget,
		signal: AbortSignal,
	): Promise<PreparedRemoteExecution> {
		if (!this.sandbox) throw sandboxFailure("sandbox_unavailable", "Remote sandbox provider is unavailable. The command was not executed.");
		const prepared = await this.sandbox.prepare({
			target: execution.target, cwd: execution.cwd, command: operation.command,
			policy: { mode: operation.sandbox?.mode ?? "workspace_write" }, signal,
		});
		signal.throwIfAborted();
		return prepared;
	}

	private async executeCommand(
		record: CommandOperationRecorder,
		target: SshTargetSnapshot,
		prepared: PreparedRemoteExecution,
		signal: AbortSignal,
	): Promise<CommandOperationResult> {
		await record.markRunning(prepared.sandbox);
		const confirmation = new SandboxConfirmationCapture({
			marker: prepared.confirmation,
			onConfirmed: () => record.confirmSandbox(prepared.sandbox),
			onOutput: (chunk) => record.recordOutput("stderr", chunk),
		});
		const result = await this.broker.execute({
			target, command: prepared.command, signal,
			onStdout: (chunk) => record.recordOutput("stdout", chunk),
			onStderr: (chunk) => confirmation.write(chunk),
		});
		record.noteExit(result);
		await confirmation.finish();
		if (!confirmation.confirmed) throw new SshAgentError({
			code: "sandbox_confirmation_missing", category: "sandbox", phase: "execute",
			message: "Remote confinement could not be confirmed. The command may have run; inspect its effects before another attempt.",
			retryable: false, safeDetails: { commandMayHaveRun: true },
		});
		await record.emitExit(result);
		return this.finishCommand(record, result);
	}

	private finishCommand(
		record: CommandOperationRecorder,
		result: RemoteExecutionResult,
	): Promise<CommandOperationResult> {
		if (result.exitSignal) return record.fail({
			code: "exit_signal_received", category: "execution", phase: "execute",
			message: "Remote command exited because of a signal", retryable: false,
			safeDetails: { signal: result.exitSignal },
		});
		if (result.exitCode === undefined) throw new SshAgentError({
			code: "execution_result_uncertain", category: "execution", phase: "execute",
			message: "Remote command returned no exit status", retryable: false,
		});
		if (result.exitCode === 0) return record.complete();
		const denialSuspected = record.operation.sandbox?.mode === "workspace_write" &&
			/permission denied|operation not permitted/i.test(record.outputTail);
		record.recordDenialSuspicion(denialSuspected);
		return record.fail({
			code: denialSuspected ? "sandbox_denied" : "remote_exit_non_zero", category: "execution", phase: "execute",
			message: denialSuspected
				? "A permission failure may be due to the sandbox. This attempt may have partial effects; inspect before requesting a new full_access approval."
				: "Remote command exited with a non-zero status",
			retryable: false, safeDetails: { exitCode: result.exitCode, commandMayHaveRun: true, denialSuspected },
		});
	}

	private async withExecutionSignal(
		operation: CommandOperation,
		callerSignal: AbortSignal | undefined,
		execute: (signal: AbortSignal) => Promise<CommandOperationResult>,
	): Promise<CommandOperationResult> {
		const controller = new AbortController();
		const abortFromCaller = () => controller.abort(callerSignal?.reason);
		callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
		const timeout = setTimeout(() => controller.abort(new SshAgentError({
			code: "execution_timeout", category: "execution", phase: "execute",
			message: "Remote command exceeded its execution timeout", retryable: false, operationId: operation.id,
		})), operation.timeoutMs);
		try {
			if (callerSignal?.aborted) abortFromCaller();
			return await execute(controller.signal);
		} finally {
			clearTimeout(timeout);
			callerSignal?.removeEventListener("abort", abortFromCaller);
		}
	}

	private recorder(operation: CommandOperation, onEvent?: SubmitCommandInput["onEvent"]): CommandOperationRecorder {
		return new CommandOperationRecorder({
			operation, repository: this.operations, clock: this.clock, onEvent,
			persistedOutputLimitBytes: COMMAND_EXECUTION_DEFAULTS.persistedOutputLimitBytes,
			outputTailLimitBytes: COMMAND_EXECUTION_DEFAULTS.llmOutputTailBytes,
		});
	}

	private async loadRecorder(
		operationId: OperationId,
		onEvent?: SubmitCommandInput["onEvent"],
	): Promise<CommandOperationRecorder> {
		const operation = await this.operations.findById(operationId);
		if (!operation) throw new Error("Command operation disappeared: " + operationId);
		return this.recorder(operation, onEvent);
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

	private async reconcileAfterRestart(): Promise<void> {
		const active = await this.operations.listByStatuses(ACTIVE_COMMAND_OPERATION_STATUSES);
		for (const operation of active) await this.recorder(operation).recoverAfterRestart();
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
