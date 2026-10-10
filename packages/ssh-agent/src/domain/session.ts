import type { SessionId, WorkspaceId } from "./ids.ts";

export interface Session {
	id: SessionId;
	/** Immutable after creation. A different Workspace requires a new Session. */
	workspaceId: WorkspaceId;
	displayName: string;
	/** Normalized absolute local path. Null uses the server default. */
	workDir: string | null;
	autoAudit: boolean;
	/** User-selected remote execution environment, independent of tool approval. */
	sandboxEnabled: boolean;
	terminalContextCursor: number;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface CreateSessionInput {
	workspaceId: WorkspaceId;
	displayName: string;
	workDir?: string;
	autoAudit?: boolean;
	sandboxEnabled?: boolean;
}

export interface UpdateSessionInput {
	id: SessionId;
	displayName?: string;
	workDir?: string | null;
	autoAudit?: boolean;
	sandboxEnabled?: boolean;
	expectedRevision: number;
}

export type RenameSessionInput = UpdateSessionInput;

export interface DeleteSessionInput {
	id: SessionId;
	expectedRevision: number;
}

export interface AdvanceTerminalContextCursorInput {
	id: SessionId;
	fromSequence: number;
	toSequence: number;
}
