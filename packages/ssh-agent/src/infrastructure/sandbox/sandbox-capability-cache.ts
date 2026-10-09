import type { SshConnectionPoolControl } from "../../application/ssh-channel-broker.ts";
import { connectionKeyFor, serializeConnectionKey, type SshTargetSnapshot } from "../../domain/ssh-target.ts";

type ConnectionState = Partial<Pick<SshConnectionPoolControl, "snapshotWorkspace">>;

/** Caches backend metadata only. Writable roots and confinement are checked by each caller. */
export class SandboxCapabilityCache<T> {
	readonly #connections: ConnectionState;
	readonly #discover: (target: SshTargetSnapshot, signal: AbortSignal) => Promise<T>;
	readonly #cached = new Map<string, { generation: number; value: T }>();
	readonly #loading = new Map<string, Promise<T>>();
	readonly #refreshing = new Map<string, Promise<T>>();

	constructor(connections: ConnectionState, discover: (target: SshTargetSnapshot, signal: AbortSignal) => Promise<T>) {
		this.#connections = connections;
		this.#discover = discover;
	}

	async get(target: SshTargetSnapshot, signal: AbortSignal): Promise<T> {
		const key = serializeConnectionKey(connectionKeyFor(target));
		for (;;) {
			signal.throwIfAborted();
			const pending = this.#refreshing.get(key) ?? this.#loading.get(key);
			if (pending) { await waitForCapability(pending, signal); continue; }
			const cached = this.#cached.get(key);
			if (cached?.generation === this.#generation(target)) return cached.value;
			return waitForCapability(this.#load(key, target, signal), signal);
		}
	}

	refresh(target: SshTargetSnapshot, signal: AbortSignal): Promise<T> {
		signal.throwIfAborted();
		const key = serializeConnectionKey(connectionKeyFor(target));
		let pending = this.#refreshing.get(key);
		if (!pending) {
			pending = this.#reload(key, target, signal).finally(() => this.#refreshing.delete(key));
			this.#refreshing.set(key, pending);
		}
		return waitForCapability(pending, signal);
	}

	async #reload(key: string, target: SshTargetSnapshot, signal: AbortSignal): Promise<T> {
		// An older discovery may repopulate the cache. Refresh starts after it settles.
		const loading = this.#loading.get(key);
		if (loading) await waitForCapability(loading, signal).catch(() => signal.throwIfAborted());
		signal.throwIfAborted();
		this.#cached.delete(key);
		return this.#load(key, target, signal);
	}

	#load(key: string, target: SshTargetSnapshot, signal: AbortSignal): Promise<T> {
		const pending = this.#discover(target, signal).then((value) => {
			signal.throwIfAborted();
			// The first SSH command may establish the connection, so record its resulting generation.
			this.#cached.set(key, { generation: this.#generation(target), value });
			return value;
		}).finally(() => this.#loading.delete(key));
		this.#loading.set(key, pending);
		return pending;
	}

	#generation(target: SshTargetSnapshot): number {
		return this.#connections.snapshotWorkspace?.(target.workspaceId).generation ?? 0;
	}
}

/** A cancelled waiter leaves the discovery owned by another request alone. */
function waitForCapability<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
		signal.addEventListener("abort", aborted, { once: true });
		pending.then((value) => { if (signal.aborted) aborted(); else resolve(value); }, reject)
			.finally(() => signal.removeEventListener("abort", aborted));
		if (signal.aborted) aborted();
	});
}
