import type { WorkspaceId } from "../../domain/ids.ts";
import type { Workspace, WorkspaceEnvironment } from "../../domain/workspace.ts";

export interface WorkspaceListFilter {
	environment?: WorkspaceEnvironment;
	query?: string;
}

export interface WorkspaceRepository {
	findById(id: WorkspaceId): Promise<Workspace | undefined>;
	list(filter?: WorkspaceListFilter): Promise<Workspace[]>;
	insert(workspace: Workspace): Promise<void>;
	update(workspace: Workspace, expectedRevision: number): Promise<boolean>;
	delete(id: WorkspaceId, expectedRevision: number): Promise<boolean>;
}
