import type { Client, ClientChannel } from "ssh2";
import type {
	OpenTerminalChannelInput,
	TerminalChannelBroker,
	TerminalChannelExit,
	TerminalChannelHandle,
} from "../../application/ssh-channel-broker.ts";
import { TERMINAL_DEFAULTS } from "../../application/terminal/terminal-defaults.ts";
import { connectionKeyFor, serializeConnectionKey } from "../../domain/ssh-target.ts";
import type { TerminalGeometry } from "../../domain/terminal.ts";
import type { Ssh2ConnectionContext, Ssh2ConnectionPool } from "./ssh2-connection-pool.ts";
import { createSshError } from "./ssh2-errors.ts";
import { TerminalStartupCapture } from "./terminal-startup-capture.ts";

type TerminalPool = Pick<Ssh2ConnectionPool, "withChannelSlot">;

export class Ssh2TerminalChannelBroker implements TerminalChannelBroker {
	readonly #pool: TerminalPool;
	readonly #activeByGeneration = new Map<string, number>();
	readonly #maxPerGeneration: number;

	constructor(pool: TerminalPool, options: { readonly maxTerminalsPerConnectionGeneration?: number } = {}) {
		this.#pool = pool;
		this.#maxPerGeneration =
			options.maxTerminalsPerConnectionGeneration ?? TERMINAL_DEFAULTS.capacity.connectionTerminalSessions;
	}

	open(input: OpenTerminalChannelInput): Promise<TerminalChannelHandle> {
		let resolveOpen: (handle: TerminalChannelHandle) => void = () => undefined;
		let rejectOpen: (error: Error) => void = () => undefined;
		let openSettled = false;
		const opened = new Promise<TerminalChannelHandle>((resolve, reject) => {
			resolveOpen = resolve;
			rejectOpen = reject;
		});
		void this.#pool
			.withChannelSlot({
				target: input.target,
				signal: input.signal,
				cancellationError: () =>
					createSshError("execution_cancelled", "channel", "cancel", "Terminal channel open was cancelled"),
				operation: async (context) => {
					const reservationKey = `${serializeConnectionKey(connectionKeyFor(input.target))}:${context.generation}`;
					this.#reserveGeneration(reservationKey);
					try {
						let runtime: OpenedTerminalRuntime | undefined;
						try {
							runtime = await openChannel(context, input);
							await waitForConfirmation(runtime, input.signal);
							openSettled = true;
							resolveOpen(runtime.handle);
							await runtime.disposed;
						} catch (error) {
							runtime?.handle.dispose();
							throw error;
						}
					} finally {
						this.#releaseGeneration(reservationKey);
					}
				},
			})
			.catch((error: unknown) => {
				if (openSettled) return;
				openSettled = true;
				rejectOpen(error instanceof Error ? error : new Error("Terminal channel open failed"));
			});
		return opened;
	}

	#reserveGeneration(key: string): void {
		const active = this.#activeByGeneration.get(key) ?? 0;
		if (active >= this.#maxPerGeneration) {
			throw createSshError(
				"channel_limit_reached",
				"channel",
				"acquire_channel",
				"Terminal capacity for the SSH connection generation was exceeded",
				{ limit: this.#maxPerGeneration },
				true,
			);
		}
		this.#activeByGeneration.set(key, active + 1);
	}

	#releaseGeneration(key: string): void {
		const active = this.#activeByGeneration.get(key) ?? 0;
		if (active <= 1) this.#activeByGeneration.delete(key);
		else this.#activeByGeneration.set(key, active - 1);
	}
}

interface OpenedTerminalRuntime {
	readonly handle: TerminalChannelHandle;
	readonly disposed: Promise<void>;
	readonly ready: Promise<void>;
	readonly isClosed: () => boolean;
}

function openChannel(context: Ssh2ConnectionContext, input: OpenTerminalChannelInput): Promise<OpenedTerminalRuntime> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			reject(createSshError("execution_cancelled", "channel", "cancel", "Terminal channel open was cancelled"));
		};
		if (input.signal.aborted) {
			onAbort();
			return;
		}
		input.signal.addEventListener("abort", onAbort, { once: true });
		const pty = { term: input.term, rows: input.geometry.rows, cols: input.geometry.cols, height: 0, width: 0 };
		const onOpened = (error: Error | undefined, channel: ClientChannel | undefined) => {
			if (settled) {
				channel?.destroy();
				return;
			}
			settled = true;
			input.signal.removeEventListener("abort", onAbort);
			if (error) {
				reject(createSshError("channel_open_failed", "channel", "acquire_channel",
					"Failed to open SSH terminal channel", undefined, false, error));
				return;
			}
			if (!channel) {
				reject(new Error("SSH terminal callback did not provide a channel"));
				return;
			}
			resolve(createHandle(context.client, context.generation, channel, input));
		};
		try {
			if (input.launch.kind === "login_shell") context.client.shell(pty, onOpened);
			else context.client.exec(input.launch.command, { pty }, onOpened);
		} catch (error) {
			input.signal.removeEventListener("abort", onAbort);
			reject(error);
		}
	});
}

async function waitForConfirmation(runtime: OpenedTerminalRuntime, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw createSshError("execution_cancelled", "channel", "cancel", "Terminal open was cancelled");
	let onAbort: () => void = () => undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(createSshError("execution_cancelled", "channel", "cancel", "Terminal open was cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([runtime.ready, cancelled]);
		if (runtime.isClosed()) throw new Error("Terminal channel closed during startup");
	}
	finally { signal.removeEventListener("abort", onAbort); }
}

function createHandle(
	client: Client,
	connectionGeneration: number,
	channel: ClientChannel,
	input: OpenTerminalChannelInput,
): OpenedTerminalRuntime {
	let resolveClosed: (exit: TerminalChannelExit) => void = () => undefined;
	let resolveDisposed: () => void = () => undefined;
	let terminalExit: Omit<TerminalChannelExit, "kind"> = {};
	let closedSettled = false;
	let disposedSettled = false;
	let readySettled = input.launch.kind === "login_shell";
	let outputStarted = false;
	let bufferedBytes = 0;
	const buffered: Buffer[] = [];
	const writesClosed = new AbortController();
	const capture = input.launch.kind === "login_shell" ? undefined : new TerminalStartupCapture(input.launch.confirmation);
	let resolveReady: () => void = () => undefined;
	let rejectReady: (error: Error) => void = () => undefined;
	const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	if (readySettled) resolveReady();
	const closed = new Promise<TerminalChannelExit>((resolve) => {
		resolveClosed = resolve;
	});
	const disposed = new Promise<void>((resolve) => {
		resolveDisposed = resolve;
	});
	const finishClosed = (exit: TerminalChannelExit) => {
		if (closedSettled) return;
		closedSettled = true;
		client.removeListener("close", onClientClose);
		if (!readySettled) {
			readySettled = true;
			rejectReady(new Error("Terminal startup confirmation was not received before channel close"));
		}
		writesClosed.abort(new Error(exit.message ?? "Terminal channel closed before the write drained"));
		resolveClosed(exit);
	};
	const onClientClose = () => finishClosed({ kind: "connection_lost", ...terminalExit });
	client.once("close", onClientClose);
	const onOutput = (chunk: Buffer) => {
		if (closedSettled) return;
		try {
			const output = capture?.write(chunk) ?? chunk;
			if (output.length !== 0 && outputStarted) input.onData(new Uint8Array(output));
			else if (output.length !== 0) {
				bufferedBytes += output.length;
				if (bufferedBytes > 64 * 1024) throw new Error("Terminal startup output exceeded its limit");
				buffered.push(output);
			}
			if (capture?.confirmed && !readySettled) { readySettled = true; resolveReady(); }
		} catch (error) {
			const failure = error instanceof Error ? error : new Error("Terminal startup failed");
			if (!readySettled) { readySettled = true; rejectReady(failure); }
			finishClosed({ kind: "error", message: failure.message });
			channel.destroy();
		}
	};
	channel.on("data", onOutput);
	channel.stderr.on("data", onOutput);
	channel.once("exit", (code: number | null, signal?: string) => {
		terminalExit = {
			...(code === null ? {} : { exitCode: code }),
			...(signal === undefined ? {} : { exitSignal: signal }),
		};
	});
	channel.once("error", (error: Error) => finishClosed({ kind: "error", message: error.message, ...terminalExit }));
	channel.once("close", () => finishClosed({ kind: "closed", ...terminalExit }));

	const handle: TerminalChannelHandle = {
		connectionGeneration,
		closed,
		isClosed: () => closedSettled,
		startOutput: () => {
			if (outputStarted) return;
			outputStarted = true;
			for (const chunk of buffered) input.onData(new Uint8Array(chunk));
			buffered.length = 0;
			bufferedBytes = 0;
		},
		write: (data) => writeChannel(channel, data, writesClosed.signal),
		resize: async (geometry: TerminalGeometry) => {
			if (closedSettled) throw new Error("Terminal channel is closed");
			channel.setWindow(geometry.rows, geometry.cols, 0, 0);
		},
		setReadPaused: (paused) => {
			if (paused) {
				channel.pause();
				channel.stderr.pause();
			} else {
				channel.resume();
				channel.stderr.resume();
			}
		},
		close: async () => {
			if (closedSettled) return;
			channel.end();
			const graceful = await Promise.race([
				closed.then(() => true),
				wait(TERMINAL_DEFAULTS.lifecycle.channelCloseTimeoutMs).then(() => false),
			]);
			if (!graceful) channel.destroy();
			await closed;
		},
		dispose: () => {
			if (disposedSettled) return;
			disposedSettled = true;
			if (!closedSettled) channel.destroy();
			resolveDisposed();
		},
	};
	return { handle, disposed, ready, isClosed: () => closedSettled };
}

async function writeChannel(
	channel: ClientChannel,
	data: Uint8Array,
	closed: AbortSignal,
): Promise<void> {
	const writable = channel.write(data);
	if (writable) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			channel.removeListener("drain", onDrain);
			channel.removeListener("error", onError);
			closed.removeEventListener("abort", onClosed);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onClosed = () => {
			cleanup();
			reject(closed.reason instanceof Error ? closed.reason : new Error("Terminal channel closed before the write drained"));
		};
		channel.once("drain", onDrain);
		channel.once("error", onError);
		closed.addEventListener("abort", onClosed, { once: true });
		if (closed.aborted) onClosed();
	});
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
