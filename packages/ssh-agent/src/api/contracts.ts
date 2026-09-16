import type { Attachment } from "../domain/attachment.ts";
import type { ChatMessageProjection, ChatModelSelection } from "../domain/chat.ts";
import type { Credential } from "../domain/credential.ts";
import type { Guard } from "../domain/guard.ts";
import type { LlmProviderCredential, LlmProviderDefinition } from "../domain/llm-provider.ts";
import type { Session } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";

export interface WorkspaceSessionTreeNode {
	workspace: Workspace;
	sessions: Session[];
}

export interface WorkspaceSessionTree {
	workspaces: WorkspaceSessionTreeNode[];
}

export type SessionDetails = Session & {
	chatModelSelection: ChatModelSelection | null;
};

export interface WorkspaceCredential {
	workspaceId: string;
	workspaceRevision: number;
	credential: Credential;
}

export interface WorkspaceCredentials {
	workspaceId: string;
	activeCredentialId: string;
	workspaceRevision: number;
	credentials: Credential[];
}

export interface ApiErrorBody {
	error: {
		code: string;
		message: string;
		field?: string;
	};
}

export interface LlmProvidersResponse {
	providers: readonly LlmProviderDefinition[];
}

export interface LlmProviderCredentialsResponse {
	credentials: readonly LlmProviderCredential[];
}

export type AttachmentResponse = Attachment & {
	contentUrl: string;
};

export type ChatMessageResponse = Omit<ChatMessageProjection, "attachments"> & {
	attachments?: AttachmentResponse[];
};

export interface ListChatMessagesResponse {
	messages: ChatMessageResponse[];
	nextBeforeSequence: number | null;
	nextSequence: number | null;
}

export type GuardConfiguration = Guard;
