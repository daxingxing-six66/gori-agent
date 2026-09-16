import type { Guard } from "../../domain/guard.ts";
import type { GuardId, WorkspaceId } from "../../domain/ids.ts";

export interface GuardRepository {
	findById(id: GuardId): Promise<Guard | undefined>;
	findByWorkspaceId(workspaceId: WorkspaceId): Promise<Guard | undefined>;
	insert(guard: Guard): Promise<void>;
	update(guard: Guard, expectedRevision: number): Promise<boolean>;
	deleteByWorkspaceId(workspaceId: WorkspaceId): Promise<void>;
}
