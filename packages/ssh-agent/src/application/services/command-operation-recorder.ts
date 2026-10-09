import { Buffer } from "node:buffer";
import type {
	CommandOperation,
	CommandOperationStatus,
	OperationEvent,
	OperationEventData,
	OperationEventType,
} from "../../domain/command-operation.ts";
import type { Clock } from "../../domain/ids.ts";
import type { RemoteSandboxFacts } from "../../domain/remote-sandbox.ts";
import { SshAgentError, type SshFailure } from "../../domain/ssh-failure.ts";
import type { CommandOperationRepository } from "../repositories/command-operation-repository.ts";
import type { RemoteExecutionResult } from "../ssh-channel-broker.ts";
import type { CommandExecutionTarget } from "./command-execution-policy.ts";
import type { CommandGuardDecision } from "./command-guard-evaluator.ts";

export interface CommandOperationResult {
	operation: CommandOperation;
	outputTail: string;
}

type FailureStatus = Extract<CommandOperationStatus, "failed" | "cancelled" | "blocked" | "uncertain">;

/** Owns one Operation's audit state and output. It never evaluates permissions or executes commands. */
export class CommandOperationRecorder {
	readonly operation: CommandOperation;
	private readonly repository: CommandOperationRepository;
	private readonly clock: Clock;
	private readonly onEvent?: (event: OperationEvent, operation: CommandOperation) => void;
	private readonly persistedOutputLimitBytes: number;
	private readonly outputTailLimitBytes: number;
	private tail = Buffer.alloc(0);

	constructor(options: {
		operation: CommandOperation;
		repository: CommandOperationRepository;
		clock: Clock;
		onEvent?: (event: OperationEvent, operation: CommandOperation) => void;
		persistedOutputLimitBytes: number;
		outputTailLimitBytes: number;
	}) {
		this.operation = options.operation;
		this.repository = options.repository;
		this.clock = options.clock;
		this.onEvent = options.onEvent;
		this.persistedOutputLimitBytes = options.persistedOutputLimitBytes;
		this.outputTailLimitBytes = options.outputTailLimitBytes;
	}

	get outputTail(): string { return this.tail.toString("utf8"); }

	async enqueue(): Promise<void> {
		await this.repository.insert(this.operation);
		await this.emit("status", { status: "created" });
		await this.transition("queued", ["created"], { enqueuedAt: this.clock.now() });
	}

	markDispatching(): Promise<void> {
		return this.transition("dispatching", ["queued"], { claimedAt: this.clock.now() });
	}

	recordGuard(decision: CommandGuardDecision): void {
		this.operation.guardRevision = decision.guardRevision;
		if (!decision.allowed) this.operation.matchedGuardRuleId = decision.matchedRule?.id;
	}

	bindExecution(execution: CommandExecutionTarget): void {
		this.operation.executionContext = execution.target;
		this.operation.resolvedCwd = execution.cwd;
	}

	markRunning(sandbox: RemoteSandboxFacts): Promise<void> {
		// Before dispatch, lost acknowledgements cannot prove the command did not run.
		return this.transition("running", ["dispatching"], {
			sandbox: { ...sandbox, enforcement: "none", commandMayHaveRun: true },
			startedAt: this.clock.now(),
		});
	}

	async confirmSandbox(sandbox: RemoteSandboxFacts): Promise<void> {
		this.operation.sandbox = { ...sandbox, commandMayHaveRun: true };
		await this.persist(["running"]);
	}

	async recordOutput(type: "stdout" | "stderr", chunk: Uint8Array): Promise<void> {
		const operation = this.operation;
		const remaining = this.persistedOutputLimitBytes - operation.outputBytes;
		operation.outputBytes += chunk.byteLength;
		this.tail = Buffer.concat([this.tail, Buffer.from(chunk)]).subarray(-this.outputTailLimitBytes);
		if (remaining > 0) {
			await this.emit(type, { chunk: Buffer.from(chunk.subarray(0, remaining)).toString("utf8") });
		}
		if (!operation.outputTruncated && operation.outputBytes > this.persistedOutputLimitBytes) {
			operation.outputTruncated = true;
			await this.emit("output_truncated", { limitBytes: this.persistedOutputLimitBytes });
		}
	}

	noteExit(result: RemoteExecutionResult): void {
		this.operation.exitCode = result.exitCode;
		this.operation.exitSignal = result.exitSignal;
	}

	recordDenialSuspicion(suspected: boolean): void {
		if (this.operation.sandbox) this.operation.sandbox.denialSuspected = suspected;
	}

	emitExit(result: RemoteExecutionResult): Promise<void> { return this.emit("exit", result); }

	async complete(): Promise<CommandOperationResult> {
		await this.transition("completed", ["running"], { finishedAt: this.clock.now() });
		return this.result();
	}

	async fail(failure: SshFailure, status: FailureStatus = statusForFailure(failure)): Promise<CommandOperationResult> {
		const operation = this.operation;
		await this.transition(status, [operation.status], {
			failure: { ...failure, operationId: operation.id, sessionId: operation.sessionId, workspaceId: operation.workspaceId },
			finishedAt: this.clock.now(),
		});
		return this.result();
	}

	async recoverAfterRestart(): Promise<void> {
		const wasRunning = this.operation.status === "running";
		if (wasRunning && this.operation.sandbox) this.operation.sandbox.commandMayHaveRun = true;
		await this.fail({
			code: wasRunning ? "execution_result_uncertain" : "service_restarted_before_dispatch",
			category: wasRunning ? "execution" : "queue",
			phase: wasRunning ? "execute" : "dispatch",
			message: wasRunning
				? "Service restarted while the remote command was running; the result is uncertain"
				: "Service restarted before the queued command could be dispatched",
			retryable: !wasRunning,
		}, wasRunning ? "uncertain" : "cancelled");
	}

	private result(): CommandOperationResult { return { operation: this.operation, outputTail: this.outputTail }; }

	private async transition(
		status: CommandOperationStatus,
		expected: readonly CommandOperationStatus[],
		patch: Partial<CommandOperation>,
	): Promise<void> {
		Object.assign(this.operation, patch, { status });
		await this.persist(expected);
		await this.emit("status", { status });
	}

	private async persist(expected: readonly CommandOperationStatus[]): Promise<void> {
		if (!(await this.repository.update(this.operation, expected))) {
			throw new SshAgentError({ code: "operation_persistence_failed", category: "persistence", phase: "persist",
				message: "Command operation state could not be persisted", retryable: false, operationId: this.operation.id });
		}
	}

	private async emit(type: OperationEventType, data: OperationEventData): Promise<void> {
		const event = await this.repository.appendEvent({ operationId: this.operation.id, timestamp: this.clock.now(), type, data });
		this.onEvent?.(event, this.operation);
	}
}

function statusForFailure(failure: SshFailure): FailureStatus {
	switch (failure.code) {
		case "guard_blocked": return "blocked";
		case "execution_result_uncertain": return "uncertain";
		case "execution_cancelled":
		case "cancelled_before_dispatch":
		case "queue_timeout": return "cancelled";
		default: return "failed";
	}
}
