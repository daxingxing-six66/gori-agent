import { randomUUID } from "node:crypto";
import { CHATGPT_PROVIDER_ID, CHATGPT_USAGE_URL, ChatGptAuthError, isChatGptCredential, type ChatGptConnection, type ChatGptSignIn } from "../../domain/chatgpt.ts";
import { backendMessage } from "../../i18n/message.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { ChatGptAuthorization, ChatGptLogin } from "../chatgpt-authorization.ts";
import { HttpBoundaryError } from "../failure-policy.ts";
import type { LlmProviderCredentialStore } from "../repositories/llm-provider-credential-store.ts";
import type { LlmModelCatalog } from "./llm-model-catalog.ts";

export interface ChatGptServiceOptions {
	credentials: LlmProviderCredentialStore;
	catalog: LlmModelCatalog;
	authorization: ChatGptAuthorization;
	resetModels(): void;
	hasActiveRun(): boolean;
}

/** One active ChatGPT account, consistent with Gori's one credential per Provider contract. */
export class ChatGptService {
	private readonly options: ChatGptServiceOptions;
	private attempt: (ChatGptSignIn & { login: ChatGptLogin; finished: Promise<void> }) | undefined;
	private starting = false;
	private disconnecting = false;
	private closed = false;

	constructor(options: ChatGptServiceOptions) { this.options = options; }

	async connection(): Promise<ChatGptConnection> {
		const stored = await this.options.credentials.read(CHATGPT_PROVIDER_ID);
		const credential = stored?.type === "oauth" && isChatGptCredential(stored) ? stored : undefined;
		return { connected: credential !== undefined, email: credential?.email || null,
			sharing: credential?.scopes.includes("chatgpt.tokens.use.direct") ?? false, manageUsageUrl: CHATGPT_USAGE_URL };
	}

	async begin(newAccount = false): Promise<ChatGptSignIn & { authorizationUrl: string }> {
		if (this.closed || this.starting || this.disconnecting || this.attempt?.status === "pending") throw chatGptError("busy", 409);
		if (newAccount && this.options.hasActiveRun()) throw new ManagementError("llm_provider_in_use", "ChatGPT has an active Chat Run");
		this.starting = true;
		try {
			const stored = await this.options.credentials.read(CHATGPT_PROVIDER_ID);
			const previous = stored?.type === "oauth" && isChatGptCredential(stored) ? stored : undefined;
			const login = await this.options.authorization.start(previous, newAccount);
			if (this.closed) { login.cancel(); throw chatGptError("sign_in_failed", 400); }
			const attempt = { id: randomUUID(), status: "pending" as ChatGptSignIn["status"], login, finished: Promise.resolve(),
				errorCode: undefined as ChatGptSignIn["errorCode"], failure: undefined as ChatGptSignIn["failure"] };
			this.attempt = attempt;
			attempt.finished = (async () => {
				try {
					const credential = await login.result;
					if (attempt.status !== "pending" || this.closed) return;
					await this.options.credentials.modify(CHATGPT_PROVIDER_ID, async (current) => {
						if (newAccount && this.options.hasActiveRun()) throw new Error("ChatGPT has an active Chat Run");
						if (attempt.status !== "pending" || this.closed || (previous
							? current?.type !== "oauth" || current.clientId !== previous.clientId
							: current !== undefined)) throw new Error("ChatGPT connection changed during sign-in");
						return credential;
					}, { signal: login.signal });
					this.options.resetModels();
					try { await this.refreshModels(login.signal); }
					catch { attempt.errorCode = "chatgpt_model_discovery_failed"; }
					if (attempt.status === "pending") attempt.status = "connected";
				} catch (error) {
					if (attempt.status === "pending") {
						attempt.status = "failed";
						attempt.errorCode = error instanceof ChatGptAuthError && error.failure.reason === "permission" ? "chatgpt_permission_required" :
							error instanceof ChatGptAuthError && error.failure.reason === "unsupported_region" ? "chatgpt_region_unsupported" : "chatgpt_sign_in_failed";
						if (error instanceof ChatGptAuthError) attempt.failure = error.failure;
					}
				}
			})();
			return { ...this.status(attempt.id), authorizationUrl: login.authorizationUrl };
		} catch { throw chatGptError("sign_in_failed", 400); }
		finally { this.starting = false; }
	}

	status(id: string): ChatGptSignIn {
		if (!this.attempt || this.attempt.id !== id) throw chatGptError("not_found", 404);
		const { status, errorCode, failure } = this.attempt;
		return { id, status, ...(errorCode ? { errorCode } : {}), ...(failure ? { failure } : {}) };
	}

	async cancel(id: string): Promise<void> {
		this.status(id);
		if (this.attempt?.status !== "pending") return;
		this.attempt.status = "cancelled";
		this.attempt.login.cancel();
		await this.attempt.finished;
	}

	async refreshModels(signal?: AbortSignal): Promise<void> {
		try { await this.options.catalog.refresh(CHATGPT_PROVIDER_ID, AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])])); }
		catch { throw chatGptError("model_discovery_failed", 502); }
	}

	async disconnect(): Promise<void> {
		if (this.closed || this.starting || this.disconnecting) throw chatGptError("busy", 409);
		if (this.options.hasActiveRun()) throw new ManagementError("llm_provider_in_use", "ChatGPT has an active Chat Run");
		this.disconnecting = true;
		try {
			if (this.attempt?.status === "pending") await this.cancel(this.attempt.id);
			// The store serializes this against refresh. Removal participates in that same transaction.
			await this.options.credentials.modify(CHATGPT_PROVIDER_ID, async (stored) => {
				if (stored?.type === "oauth" && isChatGptCredential(stored)) await this.options.authorization.revoke(stored, AbortSignal.timeout(15_000));
				this.options.credentials.removeCredential(CHATGPT_PROVIDER_ID);
				return undefined;
			});
			this.options.resetModels();
		} catch { throw chatGptError("disconnect_failed", 502); }
		finally { this.disconnecting = false; }
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.attempt?.status === "pending") await this.cancel(this.attempt.id);
	}
}

export function chatGptError(key: "busy" | "sign_in_failed" | "not_found" | "model_discovery_failed" | "disconnect_failed" | "local_browser_required", status: number): HttpBoundaryError {
	return new HttpBoundaryError(`chatgpt_${key}`, status, backendMessage(`chatgpt.${key}`));
}
