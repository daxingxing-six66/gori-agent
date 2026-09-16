import type { SessionId, WorkspaceId } from "./ids.ts";

export interface Session {
	id: SessionId;
	/** Immutable after creation. A different Workspace requires a new Session. */
	workspaceId: WorkspaceId;
	displayName: string;
	/** Normalized absolute local path. Null uses the server default. */
	workDir: string | null;
	autoAudit: boolean;
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
}

export interface UpdateSessionInput {
	id: SessionId;
	displayName?: string;
	workDir?: string | null;
	autoAudit?: boolean;
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
