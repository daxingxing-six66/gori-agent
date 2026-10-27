import { chatGptModelDocumentationUrl, parseChatGptModelDocumentation, type ChatGptModelCapabilities } from "./chatgpt-model-metadata.ts";

export interface ChatGptCapabilitySnapshot {
	capabilities: ChatGptModelCapabilities;
	url: string;
	checkedAt: number;
	stale: boolean;
}

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_MODELS = 128;
const MAX_SNAPSHOTS = 256;
const CONCURRENCY = 4;
const REFRESH_TIMEOUT_MS = 8_000;
const DOCUMENT_TIMEOUT_MS = 3_000;

/** Public facts only; no account model lists, OAuth headers, permissions or response text are cached. */
export class ChatGptCapabilityCatalog {
	private readonly snapshots = new Map<string, ChatGptCapabilitySnapshot>();
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private revision = 0;

	constructor(fetchImplementation: typeof fetch = fetch, now: () => number = Date.now) {
		this.fetch = fetchImplementation;
		this.now = now;
	}

	async refresh(ids: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, ChatGptCapabilitySnapshot>> {
		signal.throwIfAborted();
		const revision = ++this.revision;
		const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
		const refreshSignal = AbortSignal.any([signal, timeout]);
		const selected = [...new Set(ids)].filter((id) => chatGptModelDocumentationUrl(id)).slice(0, MAX_MODELS);
		const result = new Map<string, ChatGptCapabilitySnapshot>();
		// Keep the selected last successful snapshot when this optional metadata source is unavailable.
		for (const id of ids) {
			const cached = this.snapshots.get(id);
			if (cached) result.set(id, { ...structuredClone(cached), stale: true });
		}
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
			while (!refreshSignal.aborted) {
				const id = selected[next++];
				if (id === undefined) return;
				try {
					const snapshot = await this.load(id, refreshSignal);
					refreshSignal.throwIfAborted();
					if (revision !== this.revision) return;
					this.snapshots.delete(id);
					this.snapshots.set(id, snapshot);
					result.set(id, structuredClone(snapshot));
					while (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
				} catch {
					// A docs outage or format change must not replace a known limit with an invented value.
				}
			}
		}));
		signal.throwIfAborted();
		return result;
	}

	private async load(id: string, signal: AbortSignal): Promise<ChatGptCapabilitySnapshot> {
		const url = chatGptModelDocumentationUrl(id)!;
		const documentSignal = AbortSignal.any([signal, AbortSignal.timeout(DOCUMENT_TIMEOUT_MS)]);
		// Pass a fresh request init: the subscription Authorization header must never reach the docs host.
		const response = await this.fetch(url, { redirect: "error", signal: documentSignal,
			headers: { accept: "text/markdown, text/plain" } });
		if (!response.ok) throw new Error("ChatGPT model documentation is unavailable");
		const markdown = await boundedText(response, documentSignal);
		const capabilities = parseChatGptModelDocumentation(id, markdown);
		if (!capabilities) throw new Error("ChatGPT model documentation has no complete capability declaration");
		return { capabilities, url, checkedAt: this.now(), stale: false };
	}
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
	const length = response.headers.get("content-length");
	if (length && Number(length) > MAX_DOCUMENT_BYTES) { void response.body?.cancel().catch(() => undefined); throw new Error("Model documentation is too large"); }
	if (!response.body) throw new Error("Model documentation is empty");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	const abort = () => { void reader.cancel().catch(() => undefined); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > MAX_DOCUMENT_BYTES) throw new Error("Model documentation is too large");
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

// Provider instances are replaced on account changes. Share only public capabilities for that fetch source.
const catalogs = new WeakMap<typeof fetch, ChatGptCapabilityCatalog>();
export function chatGptCapabilityCatalog(fetchImplementation: typeof fetch): ChatGptCapabilityCatalog {
	let catalog = catalogs.get(fetchImplementation);
	if (!catalog) { catalog = new ChatGptCapabilityCatalog(fetchImplementation); catalogs.set(fetchImplementation, catalog); }
	return catalog;
}
