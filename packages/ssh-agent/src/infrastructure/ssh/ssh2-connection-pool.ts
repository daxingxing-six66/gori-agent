import { Client, type ConnectConfig } from "ssh2";
import type { CredentialSecretStore } from "../../application/repositories/credential-repository.ts";
import type { ConnectionPoolSnapshot, SshConnectionPoolControl } from "../../application/ssh-channel-broker.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import { connectionKeyFor, type SshTargetSnapshot, serializeConnectionKey } from "../../domain/ssh-target.ts";
import { fingerprintSshHostKey, isSupportedSshHostKeyAlgorithm } from "./ssh-host-key.ts";
import { classifyConnectionError, createSshError } from "./ssh2-errors.ts";

export interface Ssh2ConnectionPoolOptions {
	maxChannelsPerConnection?: number;
	channelAcquireTimeoutMs?: number;
	idleConnectionTimeoutMs?: number;
	reconnectDelaysMs?: readonly number[];
	random?: () => number;
}

export interface Ssh2ConnectionContext {
	readonly client: Client;
	readonly generation: number;
	isCurrent(): boolean;
}

export interface UseSsh2ChannelSlotInput<T> {
	target: SshTargetSnapshot;
	signal: AbortSignal;
	cancellationError(): Error;
	operation(context: Ssh2ConnectionContext): Promise<T>;
}

interface CapacityWaiter {
	grant(): void;
	reject(error: Error): void;
}

interface ConnectionAttempt {
	client: Client;
	promise: Promise<Client>;
	cancel(error: Error): void;
}

interface PoolEntry {
	readonly key: string;
	target: SshTargetSnapshot;
	client?: Client;
	connecting?: ConnectionAttempt;
	generation: number;
	activeChannels: number;
	waiters: CapacityWaiter[];
	idleTimer?: ReturnType<typeof setTimeout>;
	reconnectController?: AbortController;
	closed: boolean;
	connectedAt?: number;
	lastError?: { code: string; message: string };
}

export class Ssh2ConnectionPool implements SshConnectionPoolControl {
	private readonly secrets: CredentialSecretStore;
	private readonly maxChannels: number;
	private readonly channelAcquireTimeoutMs: number;
	private readonly idleConnectionTimeoutMs: number;
	private readonly reconnectDelaysMs: readonly number[];
	private readonly random: () => number;
	private readonly entries = new Map<string, PoolEntry>();
	private closed = false;

	constructor(secrets: CredentialSecretStore, options: Ssh2ConnectionPoolOptions = {}) {
		this.secrets = secrets;
		this.maxChannels = options.maxChannelsPerConnection ?? 8;
		this.channelAcquireTimeoutMs = options.channelAcquireTimeoutMs ?? 15_000;
		this.idleConnectionTimeoutMs = options.idleConnectionTimeoutMs ?? 60_000;
		this.reconnectDelaysMs = options.reconnectDelaysMs ?? [500, 1_000, 2_000, 4_000, 8_000];
		this.random = options.random ?? Math.random;
	}

	async withChannelSlot<T>(input: UseSsh2ChannelSlotInput<T>): Promise<T> {
		if (this.closed) throw poolClosedError();
		if (input.signal.aborted) throw input.cancellationError();
		const entry = this.getOrCreateEntry(input.target);
		await this.acquireCapacity(entry, input.signal, input.cancellationError);
		try {
			const client = await waitForOperation(this.getReadyClient(entry), input.signal, input.cancellationError);
			const generation = entry.generation;
			return await input.operation({
				client,
				generation,
				isCurrent: () => !entry.closed && entry.client === client && entry.generation === generation,
			});
		} finally {
			this.releaseCapacity(entry);
		}
	}

	snapshotWorkspace(workspaceId: string): ConnectionPoolSnapshot {
		const entries = [...this.entries.values()].filter((entry) => entry.target.workspaceId === workspaceId);
		const current =
			entries.find((entry) => entry.client !== undefined || entry.connecting !== undefined) ?? entries[0];
		if (!current) return { workspaceId, state: "idle", activeChannels: 0, waitingChannels: 0, generation: 0 };
		const state = current.reconnectController
			? "reconnecting"
			: current.connecting
				? "connecting"
				: current.client
					? "connected"
					: current.lastError
						? "failed"
						: "idle";
		return {
			workspaceId,
			state,
			activeChannels: current.activeChannels,
			waitingChannels: current.waiters.length,
			generation: current.generation,
			...(current.connectedAt === undefined ? {} : { connectedAt: current.connectedAt }),
			...(current.lastError === undefined ? {} : { lastError: current.lastError }),
		};
	}

	invalidateWorkspace(workspaceId: string): void {
		for (const entry of [...this.entries.values()]) {
			if (entry.target.workspaceId === workspaceId) this.destroyEntry(entry, "connection_invalidated");
		}
	}

	invalidateCredential(credentialId: string): void {
		for (const entry of [...this.entries.values()]) {
			if (entry.target.credentialId === credentialId) this.destroyEntry(entry, "connection_invalidated");
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const entry of [...this.entries.values()]) this.destroyEntry(entry, "connection_pool_closed");
	}

	private getOrCreateEntry(target: SshTargetSnapshot): PoolEntry {
		const key = serializeConnectionKey(connectionKeyFor(target));
		const existing = this.entries.get(key);
		if (existing) {
			existing.target = target;
			return existing;
		}
		const entry: PoolEntry = {
			key,
			target,
			generation: 0,
			activeChannels: 0,
			waiters: [],
			closed: false,
		};
		this.entries.set(key, entry);
		return entry;
	}

	private async acquireCapacity(entry: PoolEntry, signal: AbortSignal, cancellationError: () => Error): Promise<void> {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		if (entry.closed) throw entryClosedError();
		if (signal.aborted) throw cancellationError();
		if (entry.activeChannels < this.maxChannels) {
			entry.activeChannels += 1;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const remove = () => {
				const index = entry.waiters.indexOf(waiter);
				if (index >= 0) entry.waiters.splice(index, 1);
			};
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				callback();
			};
			const onAbort = () => {
				remove();
				finish(() => reject(cancellationError()));
			};
			const waiter: CapacityWaiter = {
				grant: () =>
					finish(() => {
						entry.activeChannels += 1;
						resolve();
					}),
				reject: (error) => finish(() => reject(error)),
			};
			const timer = setTimeout(() => {
				remove();
				finish(() =>
					reject(
						createSshError(
							"channel_acquire_timeout",
							"channel",
							"acquire_channel",
							"Timed out waiting for an SSH channel",
						),
					),
				);
			}, this.channelAcquireTimeoutMs);
			entry.waiters.push(waiter);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private releaseCapacity(entry: PoolEntry): void {
		entry.activeChannels = Math.max(0, entry.activeChannels - 1);
		const waiter = entry.waiters.shift();
		if (waiter) {
			waiter.grant();
			return;
		}
		if (entry.activeChannels === 0 && !entry.closed) {
			entry.idleTimer = setTimeout(
				() => this.destroyEntry(entry, "connection_invalidated"),
				this.idleConnectionTimeoutMs,
			);
		}
	}

	private async getReadyClient(entry: PoolEntry): Promise<Client> {
		if (entry.closed) throw entryClosedError();
		if (entry.client) return entry.client;
		if (entry.connecting) return entry.connecting.promise;
		const attempt = this.createConnectionAttempt(entry);
		entry.connecting = attempt;
		void attempt.promise.then(
			() => {
				if (entry.connecting === attempt) entry.connecting = undefined;
			},
			(error: unknown) => {
				if (entry.connecting === attempt) entry.connecting = undefined;
				entry.lastError =
					error instanceof SshAgentError
						? { code: error.failure.code, message: error.failure.message }
						: { code: "transport_lost", message: "SSH connection could not be established" };
			},
		);
		return attempt.promise;
	}

	private createConnectionAttempt(entry: PoolEntry): ConnectionAttempt {
		const target = entry.target;
		const hostKeyAlgorithm = target.hostKeyAlgorithm;
		if (!isSupportedSshHostKeyAlgorithm(hostKeyAlgorithm)) {
			return rejectedAttempt(
				createSshError(
					"host_key_algorithm_unsupported",
					"host_trust",
					"verify_host",
					"Workspace host key algorithm is not supported",
					{ algorithm: hostKeyAlgorithm },
				),
			);
		}
		const client = new Client();
		let settled = false;
		let observedFingerprint: string | undefined;
		let resolveAttempt = (_client: Client) => {};
		let rejectAttempt = (_error: Error) => {};
		const promise = new Promise<Client>((resolve, reject) => {
			resolveAttempt = resolve;
			rejectAttempt = reject;
		});
		const cleanup = () => {
			client.removeListener("ready", onReady);
			client.removeListener("error", onError);
			client.removeListener("close", onCloseBeforeReady);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			client.on("error", ignoreClientError);
			client.destroy();
			rejectAttempt(error);
		};
		const onReady = () => {
			if (entry.closed || this.closed || this.entries.get(entry.key) !== entry) {
				fail(entryClosedError());
				return;
			}
			if (settled) return;
			settled = true;
			cleanup();
			client.on("error", ignoreClientError);
			entry.client = client;
			entry.generation += 1;
			entry.connectedAt = Date.now();
			entry.lastError = undefined;
			client.on("close", () => this.onUnexpectedClose(entry, client));
			resolveAttempt(client);
		};
		const onError = (error: Error) => fail(classifyConnectionError(error, target, observedFingerprint));
		const onCloseBeforeReady = () =>
			fail(
				entry.closed || this.closed
					? entryClosedError()
					: createSshError(
							"transport_lost",
							"connection",
							"connect",
							"SSH connection closed before it became ready",
							undefined,
							true,
						),
			);
		void this.secrets.get(target.credentialId, target.credentialAuthVersion).then(
			(secret) => {
				if (settled) return;
				if (!secret) {
					fail(
						createSshError(
							"credential_secret_unavailable",
							"authentication",
							"authenticate",
							"SSH credential secret is unavailable",
						),
					);
					return;
				}
				if (entry.closed || this.closed) {
					fail(entryClosedError());
					return;
				}
				const config: ConnectConfig = {
					host: target.hostname,
					port: target.port,
					username: target.remoteUser,
					readyTimeout: target.connectTimeoutMs,
					keepaliveInterval: target.keepaliveIntervalMs,
					keepaliveCountMax: target.keepaliveMaxCount,
					algorithms: { serverHostKey: [hostKeyAlgorithm] },
					hostVerifier: (key: Buffer) => {
						observedFingerprint = fingerprintSshHostKey(key);
						return observedFingerprint === target.hostKeyFingerprint;
					},
					...(secret.type === "password"
						? { password: secret.password }
						: {
								privateKey: secret.privateKey,
								...(secret.passphrase === undefined ? {} : { passphrase: secret.passphrase }),
							}),
				};
				client.once("ready", onReady);
				client.once("error", onError);
				client.once("close", onCloseBeforeReady);
				try {
					client.connect(config);
				} catch (error) {
					onError(error instanceof Error ? error : new Error("SSH client configuration failed"));
				}
			},
			(error: unknown) => fail(error instanceof Error ? error : new Error("SSH credential secret lookup failed")),
		);
		return { client, promise, cancel: fail };
	}

	private onUnexpectedClose(entry: PoolEntry, client: Client): void {
		if (entry.client !== client) return;
		entry.client = undefined;
		if (entry.closed || this.closed || entry.reconnectController) return;
		const controller = new AbortController();
		entry.reconnectController = controller;
		void this.reconnect(entry, controller.signal).finally(() => {
			if (entry.reconnectController === controller) entry.reconnectController = undefined;
		});
	}

	private async reconnect(entry: PoolEntry, signal: AbortSignal): Promise<void> {
		for (const baseDelay of this.reconnectDelaysMs) {
			if (entry.closed || this.closed || signal.aborted) return;
			const continued = await waitDelay(Math.max(0, Math.round(baseDelay * (0.8 + this.random() * 0.4))), signal);
			if (!continued || entry.closed || this.closed) return;
			try {
				await this.getReadyClient(entry);
				return;
			} catch (error) {
				if (error instanceof SshAgentError && !error.failure.retryable) return;
			}
		}
	}

	private destroyEntry(entry: PoolEntry, code: "connection_invalidated" | "connection_pool_closed"): void {
		if (entry.closed) return;
		entry.closed = true;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		entry.reconnectController?.abort();
		entry.reconnectController = undefined;
		const error =
			code === "connection_pool_closed"
				? poolClosedError()
				: createSshError("connection_invalidated", "connection", "connect", "SSH connection was invalidated");
		for (const waiter of entry.waiters.splice(0)) waiter.reject(error);
		entry.connecting?.cancel(error);
		entry.connecting = undefined;
		entry.client?.destroy();
		entry.client = undefined;
		this.entries.delete(entry.key);
	}
}

function rejectedAttempt(error: Error): ConnectionAttempt {
	const client = new Client();
	return { client, promise: Promise.reject(error), cancel: () => {} };
}

function poolClosedError(): SshAgentError {
	return createSshError("connection_pool_closed", "connection", "connect", "SSH connection pool is closed");
}

function entryClosedError(): SshAgentError {
	return createSshError("connection_invalidated", "connection", "connect", "SSH connection was invalidated");
}

function ignoreClientError(): void {}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal, cancellationError: () => Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => finish(() => reject(cancellationError()));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function waitDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (continued: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(continued);
		};
		const onAbort = () => finish(false);
		const timer = setTimeout(() => finish(true), milliseconds);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}
