import type { ChatGptCredential } from "../domain/chatgpt.ts";

export interface ChatGptLogin {
	authorizationUrl: string;
	result: Promise<ChatGptCredential>;
	signal: AbortSignal;
	cancel(): void;
}

export interface ChatGptAuthorization {
	start(previous: ChatGptCredential | undefined, newAccount: boolean): Promise<ChatGptLogin>;
	revoke(credential: ChatGptCredential, signal: AbortSignal): Promise<void>;
}
