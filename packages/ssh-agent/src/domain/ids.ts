export type WorkspaceId = string;
export type SessionId = string;
export type CredentialId = string;
export type GuardId = string;
export type OperationId = string;
export type TerminalSessionId = string;
export type TerminalInteractionId = string;
export type TerminalInputId = string;
export type TerminalObservationId = string;
export type TerminalAttachmentId = string;
export type AttachmentId = string;

/** Injectable clock used by application services. */
export interface Clock {
	now(): number;
}

/** Injectable collision-resistant identifier source. */
export interface IdGenerator {
	next(): string;
}
