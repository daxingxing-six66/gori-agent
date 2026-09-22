import type { SFTPWrapper } from "ssh2";
import type { SftpPathInput } from "../../application/ssh-channel-broker.ts";
import { FileTransferError } from "../../domain/file-transfer.ts";
import { connectionKeyFor, serializeConnectionKey } from "../../domain/ssh-target.ts";
import { createSshError } from "./ssh2-errors.ts";
import type { Ssh2ConnectionContext, Ssh2ConnectionPool } from "./ssh2-connection-pool.ts";

interface SharedChannel {
	ready: Promise<{ sftp: SFTPWrapper; context: Ssh2ConnectionContext }>;
	users: number;
	stopped: boolean;
	idle?: ReturnType<typeof setTimeout>;
	context?: Ssh2ConnectionContext;
	stop(): void;
}

/** One multiplexed SFTP subsystem per connection identity, retained briefly between operations. */
export class Ssh2SftpChannelPool {
	readonly #pool: Pick<Ssh2ConnectionPool, "withChannelSlot">;
	readonly #channels = new Map<string, SharedChannel>();
	#closed = false;

	constructor(pool: Pick<Ssh2ConnectionPool, "withChannelSlot">) {
		this.#pool = pool;
	}

	async use<T>(
		input: SftpPathInput,
		operation: (sftp: SFTPWrapper, context: Ssh2ConnectionContext) => Promise<T>,
		cancellationError: () => Error = () => new FileTransferError("transfer_cancelled", "SFTP operation was cancelled", 409),
	): Promise<T> {
		if (input.signal.aborted) throw cancellationError();
		if (this.#closed) throw channelClosed();
		const key = serializeConnectionKey(connectionKeyFor(input.target));
		let shared = this.#channels.get(key);
		if (shared?.context && !shared.context.isCurrent()) shared.stop();
		if (!shared || shared.stopped) {
			shared = this.#open(key, input);
			this.#channels.set(key, shared);
		}
		if (shared.idle) clearTimeout(shared.idle);
		shared.users++;
		try {
			const { sftp, context } = await waitForChannel(shared.ready, input.signal, cancellationError);
			if (shared.stopped || !context.isCurrent()) throw channelClosed();
			if (input.signal.aborted) throw cancellationError();
			return await operation(sftp, context);
		} finally {
			shared.users--;
			if (shared.users === 0 && !shared.stopped) {
				// No caller needs a pending open. A ready channel stays warm for stat -> transfer.
				if (!shared.context) shared.stop();
				else {
					shared.idle = setTimeout(() => shared.stop(), 1_000);
					shared.idle.unref();
				}
			}
		}
	}

	close(): void {
		this.#closed = true;
		for (const channel of this.#channels.values()) channel.stop();
	}

	#open(key: string, input: SftpPathInput): SharedChannel {
		const controller = new AbortController();
		let release!: () => void;
		const lifetime = new Promise<void>((resolve) => { release = resolve; });
		let ready!: (value: { sftp: SFTPWrapper; context: Ssh2ConnectionContext }) => void;
		let failed!: (error: unknown) => void;
		const promise = new Promise<{ sftp: SFTPWrapper; context: Ssh2ConnectionContext }>((resolve, reject) => {
			ready = resolve; failed = reject;
		});
		// Opening can outlive an individually cancelled waiter.
		void promise.catch(() => {});
		let sftp: SFTPWrapper | undefined;
		let cleanup = () => {};
		const shared: SharedChannel = {
			ready: promise, users: 0, stopped: false,
			stop: () => {
				if (shared.stopped) return;
				shared.stopped = true;
				if (shared.idle) clearTimeout(shared.idle);
				if (this.#channels.get(key) === shared) this.#channels.delete(key);
				controller.abort();
				failed(channelClosed());
				cleanup();
				sftp?.end();
				release();
			},
		};
		void this.#pool.withChannelSlot({
			target: input.target,
			signal: controller.signal,
			cancellationError: channelClosed,
			operation: async (connection) => {
				const onClose = () => shared.stop();
				connection.client.once("close", onClose);
				cleanup = () => connection.client.removeListener("close", onClose);
				try {
					// Do not bind opening to a single transfer's AbortSignal.
					const opened = new Promise<void>((resolve, reject) => {
						connection.client.sftp((error, channel) => {
							if (error) {
								reject(createSshError("sftp_channel_open_failed", "channel", "acquire_channel", "Failed to open SSH SFTP channel", undefined, false, error));
								return;
							}
							channel.on("error", onClose);
							if (shared.stopped) { channel.end(); resolve(); return; }
							sftp = channel;
							channel.once("close", onClose);
							const context: Ssh2ConnectionContext = {
								...connection,
								isCurrent: () => !shared.stopped && connection.isCurrent(),
							};
							shared.context = context;
							ready({ sftp: channel, context });
							resolve();
						});
					});
					await Promise.race([opened, lifetime]);
					await lifetime;
				} catch (error) {
					failed(error);
				} finally { shared.stop(); }
			},
		}).catch((error: unknown) => {
			failed(error);
			shared.stop();
		});
		return shared;
	}
}

function channelClosed(): FileTransferError {
	return new FileTransferError("sftp_operation_failed", "SFTP channel is closed", 502);
}

function waitForChannel<T>(promise: Promise<T>, signal: AbortSignal, cancellationError: () => Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(cancellationError()); };
		if (signal.aborted) { onAbort(); return; }
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
	});
}
