const STORAGE_KEY = "gori-session-activity-read-v1";
const MAX_RECEIPTS = 256;

type ReadStateStorage = Pick<Storage, "getItem" | "setItem">;

/** Read receipts belong to this browser, independently of the server's Run facts. */
export class SessionActivityReadState {
	readonly #runs = new Map<string, string>();
	readonly #storage?: ReadStateStorage;

	constructor(storage?: ReadStateStorage) {
		this.#storage = storage;
		try {
			const stored = storage?.getItem(STORAGE_KEY);
			const receipts: unknown = stored ? JSON.parse(stored) : [];
			if (Array.isArray(receipts) && receipts.every(isReceipt)) {
				for (const [sessionId, runId] of receipts.slice(-MAX_RECEIPTS)) this.#runs.set(sessionId, runId);
			}
		} catch { /* Unavailable or invalid storage falls back to in-memory receipts. */ }
	}

	hasRead(sessionId: string, runId: string): boolean { return this.#runs.get(sessionId) === runId; }

	markRead(sessionId: string, runId: string): void {
		if (this.hasRead(sessionId, runId)) return;
		this.#runs.delete(sessionId);
		this.#runs.set(sessionId, runId);
		if (this.#runs.size > MAX_RECEIPTS) this.#runs.delete(this.#runs.keys().next().value!);
		try { this.#storage?.setItem(STORAGE_KEY, JSON.stringify([...this.#runs])); }
		catch { /* Quota or storage restrictions must not prevent dismissing the indicator. */ }
	}
}

export function createBrowserActivityReadState(): SessionActivityReadState {
	try { return new SessionActivityReadState(typeof window === "undefined" ? undefined : window.localStorage); }
	catch { return new SessionActivityReadState(); }
}

function isReceipt(value: unknown): value is [string, string] {
	return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string" && part.trim().length > 0);
}
