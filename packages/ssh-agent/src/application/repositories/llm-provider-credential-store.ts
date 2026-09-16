import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { DeleteLlmProviderCredentialInput, LlmProviderCredential } from "../../domain/llm-provider.ts";

export interface PutLlmProviderCredentialInput {
	providerId: string;
	credential: Credential;
	expectedRevision?: number;
	updatedAt: number;
}

export interface PutLlmProviderCredentialResult {
	credential: LlmProviderCredential;
	created: boolean;
}

export interface LlmProviderCredentialStore extends CredentialStore {
	getMetadata(providerId: string): Promise<LlmProviderCredential | undefined>;
	listMetadata(): Promise<readonly LlmProviderCredential[]>;
	putCredential(input: PutLlmProviderCredentialInput): PutLlmProviderCredentialResult;
	deleteCredential(input: DeleteLlmProviderCredentialInput): void;
	removeCredential(providerId: string): void;
}
