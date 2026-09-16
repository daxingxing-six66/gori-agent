import type { SessionId, WorkspaceId } from "../../domain/ids.ts";
import type { AdvanceTerminalContextCursorInput, Session } from "../../domain/session.ts";

export interface SessionRepository {
	findById(id: SessionId): Promise<Session | undefined>;
	listByWorkspaceId(workspaceId: WorkspaceId): Promise<Session[]>;
	listAll(): Promise<Session[]>;
	insert(session: Session): Promise<void>;
	update(session: Session, expectedRevision: number): Promise<boolean>;
	delete(id: SessionId, expectedRevision: number): Promise<boolean>;
	countByWorkspaceId(workspaceId: WorkspaceId): Promise<number>;
	advanceTerminalContextCursor(input: AdvanceTerminalContextCursorInput): Promise<boolean>;
}
