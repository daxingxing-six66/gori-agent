import { StringDecoder } from "node:string_decoder";
import type { RemoteCommandBroker, RemoteExecutionResult } from "../../application/ssh-channel-broker.ts";
import { SshAgentError, type SshFailureCode } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";

interface SandboxCommand {
	target: SshTargetSnapshot;
	signal: AbortSignal;
	command: string;
	stage: string;
	code?: SshFailureCode;
}

export interface SandboxCommandResult extends RemoteExecutionResult {
	stdout: string;
	stderr: string;
}

/** Runs preparation checks with bounded diagnostics; never runs the user's command. */
export class SandboxCommandRunner {
	readonly #broker: RemoteCommandBroker;
	constructor(broker: RemoteCommandBroker) { this.#broker = broker; }

	async checked(input: SandboxCommand): Promise<string> {
		const result = await this.capture(input);
		if (result.exitCode !== 0 || result.exitSignal) throw sandboxCommandFailure(input, result);
		return result.stdout;
	}

	async capture(input: SandboxCommand): Promise<SandboxCommandResult> {
		input.signal.throwIfAborted();
		const stdout = new BoundedOutput(16_384);
		const stderr = new BoundedOutput(4_096);
		try {
			const result = await this.#broker.execute({ target: input.target, signal: input.signal, command: input.command,
				onStdout: async (chunk) => {
					stdout.append(chunk);
					if (stdout.truncated) throw sandboxPreparationFailure("sandbox_probe_failed", input.stage,
						new Error("Probe stdout exceeded 16384 bytes"));
				}, onStderr: async (chunk) => stderr.append(chunk) });
			input.signal.throwIfAborted();
			return { ...result, stdout: stdout.finish(), stderr: stderr.finish() };
		} catch (error) {
			input.signal.throwIfAborted();
			throw sandboxPreparationFailure(input.code ?? "sandbox_probe_failed", input.stage, error, stderr.finish());
		}
	}
}

export function sandboxCommandFailure(input: Pick<SandboxCommand, "stage" | "code">, result: SandboxCommandResult): SshAgentError {
	const status = result.exitSignal ? `signal=${result.exitSignal}` : `exitCode=${result.exitCode ?? "unknown"}`;
	const error = sandboxPreparationFailure(input.code ?? "sandbox_probe_failed", input.stage, new Error(status), result.stderr);
	const detail = result.stderr || (result.exitCode === 0 ? result.stdout : "");
	return new SshAgentError({ ...error.failure,
		message: `Remote sandbox check "${input.stage}" failed (${status})${detail ? `: ${diagnosticText(detail)}` : ""}. The command was not executed.`,
		safeDetails: { ...error.failure.safeDetails, ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
			...(result.exitSignal ? { exitSignal: result.exitSignal } : {}),
			...(result.stdout ? { stdout: diagnosticText(result.stdout) } : {}) },
	}, error.cause instanceof Error ? error.cause : error);
}

export function sandboxPreparationFailure(code: SshFailureCode, stage: string, error: unknown, stderr = ""): SshAgentError {
	if (error instanceof SshAgentError && error.failure.safeDetails?.sandboxStage) return error;
	const cause = error instanceof Error ? error : new Error("Unknown preparation error");
	const original = error instanceof SshAgentError ? error.failure : undefined;
	const detail = diagnosticText(stderr || cause.message);
	return new SshAgentError({
		code, category: "sandbox", phase: "sandbox_prepare", retryable: false,
		...original,
		message: `Remote sandbox check "${stage}" failed: ${detail}. The command was not executed.`,
		safeDetails: { ...original?.safeDetails, commandMayHaveRun: false, sandboxStage: stage,
			...(stderr ? { stderr: diagnosticText(stderr) } : {}) },
	}, cause);
}

function diagnosticText(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().slice(0, 4_096);
}

class BoundedOutput {
	readonly #limit: number;
	readonly #decoder = new StringDecoder("utf8");
	#bytes = 0;
	#text = "";
	truncated = false;
	constructor(limit: number) { this.#limit = limit; }

	append(chunk: Uint8Array): void {
		const remaining = this.#limit - this.#bytes;
		this.#text += this.#decoder.write(Buffer.from(chunk.subarray(0, remaining)));
		this.#bytes += Math.min(chunk.byteLength, remaining);
		this.truncated ||= chunk.byteLength > remaining;
	}

	finish(): string {
		this.#text += this.#decoder.end();
		return this.#text + (this.truncated ? " [truncated]" : "");
	}
}
