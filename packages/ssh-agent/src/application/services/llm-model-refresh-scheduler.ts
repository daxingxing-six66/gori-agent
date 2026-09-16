import type { LlmProviderCredentialStore } from "../repositories/llm-provider-credential-store.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";

export const LLM_MODEL_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

export interface LlmModelRefreshSchedulerOptions {
	catalog: LlmModelCatalog;
	credentials: LlmProviderCredentialStore;
	intervalMs?: number;
	onError?: (providerId: string, error: unknown) => void;
	shouldRefreshProvider?: (providerId: string) => boolean;
}

export class LlmModelRefreshScheduler {
	private readonly catalog: LlmModelCatalog;
	private readonly credentials: LlmProviderCredentialStore;
	private readonly onError: (providerId: string, error: unknown) => void;
	private readonly shouldRefreshProvider: (providerId: string) => boolean;
	private readonly controllers = new Map<string, AbortController>();
	private readonly timer: ReturnType<typeof setInterval>;
	private closed = false;

	constructor(options: LlmModelRefreshSchedulerOptions) {
		this.catalog = options.catalog;
		this.credentials = options.credentials;
		this.onError = options.onError ?? (() => undefined);
		this.shouldRefreshProvider = options.shouldRefreshProvider ?? (() => true);
		this.timer = setInterval(() => this.scheduleRefresh(), options.intervalMs ?? LLM_MODEL_REFRESH_INTERVAL_MS);
		this.timer.unref();
		this.scheduleRefresh();
	}

	async refreshConfigured(): Promise<void> {
		if (this.closed) return;
		const credentials = await this.credentials.listMetadata();
		await Promise.all(
			credentials
				.filter((credential) => this.shouldRefreshProvider(credential.providerId))
				.map((credential) => this.refreshProvider(credential.providerId)),
		);
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
	}

	private async refreshProvider(providerId: string): Promise<void> {
		if (this.closed || this.controllers.has(providerId)) return;
		const controller = new AbortController();
		this.controllers.set(providerId, controller);
		try {
			await this.catalog.refresh(providerId, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) this.onError(providerId, error);
		} finally {
			this.controllers.delete(providerId);
		}
	}

	private scheduleRefresh(): void {
		void this.refreshConfigured().catch((error: unknown) => this.onError("*", error));
	}
}
