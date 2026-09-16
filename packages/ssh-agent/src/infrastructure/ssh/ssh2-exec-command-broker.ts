import type { ClientChannel } from "ssh2";
import type {
	ExecuteRemoteCommandInput,
	RemoteCommandBroker,
	RemoteExecutionResult,
} from "../../application/ssh-channel-broker.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { Ssh2ConnectionContext, Ssh2ConnectionPool } from "./ssh2-connection-pool.ts";
import { createSshError } from "./ssh2-errors.ts";

export class Ssh2ExecCommandBroker implements RemoteCommandBroker {
	private readonly pool: Ssh2ConnectionPool;

	constructor(pool: Ssh2ConnectionPool) {
		this.pool = pool;
	}

	execute(input: ExecuteRemoteCommandInput): Promise<RemoteExecutionResult> {
		return this.pool.withChannelSlot({
			target: input.target,
			signal: input.signal,
			cancellationError: () => executionCancellationError(input.signal),
			operation: (context) => executeOnClient(context, input),
		});
	}
}

function executeOnClient(
	context: Ssh2ConnectionContext,
	input: ExecuteRemoteCommandInput,
): Promise<RemoteExecutionResult> {
	const { client } = context;
	return new Promise<RemoteExecutionResult>((resolve, reject) => {
		let stream: ClientChannel | undefined;
		let settled = false;
		let writeFailure: Error | undefined;
		const writes = new Set<Promise<void>>();
		const onClientClose = () => {
			if (!settled) {
				fail(
					createSshError(
						"execution_result_uncertain",
						"execution",
						"execute",
						"SSH transport was lost while the command was running; the remote result is uncertain",
						{ generation: context.generation },
					),
				);
			}
		};
		const cleanup = () => {
			input.signal.removeEventListener("abort", onAbort);
			client.removeListener("close", onClientClose);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			stream?.close();
			reject(error);
		};
		const write = (chunk: Buffer, sink: (value: Uint8Array) => Promise<void>) => {
			const pending = sink(new Uint8Array(chunk)).catch((error: unknown) => {
				writeFailure =
					error instanceof Error
						? error
						: createSshError(
								"operation_event_persistence_failed",
								"persistence",
								"persist",
								"Failed to persist command output",
							);
			});
			writes.add(pending);
			void pending.finally(() => writes.delete(pending));
		};
		const onAbort = () => {
			stream?.signal("KILL");
			fail(executionCancellationError(input.signal));
		};
		if (input.signal.aborted) {
			onAbort();
			return;
		}
		input.signal.addEventListener("abort", onAbort, { once: true });
		client.once("close", onClientClose);
		client.exec(input.command, (error, channel) => {
			if (error) {
				fail(
					createSshError(
						"channel_open_failed",
						"channel",
						"acquire_channel",
						"Failed to open SSH exec channel",
						undefined,
						false,
						error,
					),
				);
				return;
			}
			stream = channel;
			channel.on("data", (chunk: Buffer) => write(chunk, input.onStdout));
			channel.stderr.on("data", (chunk: Buffer) => write(chunk, input.onStderr));
			channel.once("error", (channelError: Error) =>
				fail(
					createSshError(
						"channel_closed",
						"channel",
						"execute",
						"SSH command channel failed",
						undefined,
						false,
						channelError,
					),
				),
			);
			channel.once("close", (exitCode?: number, exitSignal?: string) => {
				if (settled) return;
				settled = true;
				cleanup();
				void Promise.allSettled(writes).then(() => {
					if (writeFailure) reject(writeFailure);
					else
						resolve({
							...(exitCode === undefined ? {} : { exitCode }),
							...(exitSignal ? { exitSignal } : {}),
						});
				});
			});
		});
	});
}

function executionCancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof SshAgentError
		? signal.reason
		: createSshError("execution_cancelled", "execution", "cancel", "Remote command execution was cancelled");
}
