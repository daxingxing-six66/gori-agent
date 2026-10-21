import type { OAuthCredential } from "@earendil-works/pi-ai";

export const CHATGPT_PROVIDER_ID = "openai-chatgpt";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export interface ChatGptCredential extends OAuthCredential {
	clientId: string;
	subject: string;
	issuer: string;
	email: string;
	idToken: string;
	scopes: string[];
}

export function isChatGptCredential(value: OAuthCredential | undefined): value is ChatGptCredential {
	return value !== undefined && typeof value.clientId === "string" && value.clientId.length > 0 &&
		typeof value.subject === "string" && value.subject.length > 0 && value.issuer === CHATGPT_ISSUER &&
		typeof value.email === "string" && typeof value.idToken === "string" &&
		Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string");
}

export interface ChatGptConnection {
	connected: boolean;
	email: string | null;
	sharing: boolean;
	manageUsageUrl: string;
}

export type ChatGptSignInStatus = "pending" | "connected" | "cancelled" | "failed";
export interface ChatGptSignIn {
	id: string;
	status: ChatGptSignInStatus;
	/** Only a safe, localizable code. Never an upstream response or authorization URL. */
	errorCode?: "chatgpt_sign_in_failed" | "chatgpt_permission_required" | "chatgpt_model_discovery_failed" | "chatgpt_region_unsupported";
	failure?: ChatGptAuthFailure;
}

export interface ChatGptAuthFailure {
	stage: "callback" | "token_exchange" | "identity" | "refresh" | "revocation";
	reason: "timeout" | "network" | "http" | "unsupported_region" | "invalid_identity" | "invalid_response" | "invalid_grant" | "state" | "client_id" | "permission" | "cancelled";
	httpStatus?: number;
	transportCode?: string;
	upstreamCode?: "unsupported_country_region_territory" | "invalid_grant" | "invalid_client" | "unauthorized_client" | "access_denied";
}

export class ChatGptAuthError extends Error {
	readonly failure: ChatGptAuthFailure;
	constructor(failure: ChatGptAuthFailure) {
		super(`ChatGPT ${failure.stage}: ${failure.reason}${failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ""}`);
		this.name = "ChatGptAuthError";
		this.failure = failure;
	}
}
