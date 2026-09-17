import type { TestWorkspaceConnectionInput, TestWorkspaceConnectionResult } from "../model/workspace";

export type ConnectionTestState = { status: "idle" | "testing" | "success" } | { status: "error"; error: unknown };

export function canTestConnection(input: TestWorkspaceConnectionInput | null): boolean {
	if (!input || !input.host.hostname.trim() || input.host.hostname.trim().length > 253) return false;
	if (!Number.isSafeInteger(input.host.port) || input.host.port < 1 || input.host.port > 65535) return false;
	const credential = input.credential;
	if (!credential.remoteUser.trim() || !credential.displayName.trim()) return false;
	if (!(credential.type === "password" ? credential.password : credential.privateKey).trim()) return false;
	const settings = { connectTimeoutMs: 10000, keepaliveIntervalMs: 15000, keepaliveMaxCount: 3, ...input.connection };
	return Object.values(settings).every((value) => Number.isSafeInteger(value) && value >= 0)
		&& settings.connectTimeoutMs > 0 && settings.connectTimeoutMs <= 2_147_483_647;
}

/** Owns cancellation and stale-response protection without retaining draft credentials. */
export class ConnectionTestController {
	#state: ConnectionTestState = { status: "idle" };
	#request = 0;
	#abort?: AbortController;
	readonly #listeners = new Set<() => void>();
	readonly #test: (input: TestWorkspaceConnectionInput, signal: AbortSignal) => Promise<TestWorkspaceConnectionResult>;
	constructor(test: (input: TestWorkspaceConnectionInput, signal: AbortSignal) => Promise<TestWorkspaceConnectionResult>) { this.#test = test; }
	getSnapshot = (): ConnectionTestState => this.#state;
	subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
	#publish(state: ConnectionTestState): void { this.#state = state; for (const listener of this.#listeners) listener(); }
	reset = (): void => {
		this.#request++;
		this.#abort?.abort();
		this.#abort = undefined;
		this.#publish({ status: "idle" });
	};
	async run(input: TestWorkspaceConnectionInput): Promise<void> {
		if (this.#state.status === "testing" || !canTestConnection(input)) return;
		const request = ++this.#request;
		const abort = new AbortController();
		this.#abort = abort;
		this.#publish({ status: "testing" });
		try {
			await this.#test(input, abort.signal);
			if (request === this.#request) this.#publish({ status: "success" });
		} catch (error) {
			if (request === this.#request) this.#publish({ status: "error", error });
		} finally {
			if (request === this.#request) this.#abort = undefined;
		}
	}
}
