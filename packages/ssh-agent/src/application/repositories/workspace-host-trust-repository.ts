import type { WorkspaceId } from "../../domain/ids.ts";
import type { VerifiedHostKey } from "../../domain/workspace.ts";

export interface WorkspaceHostTrustRepository {
	findByWorkspaceId(workspaceId: WorkspaceId): Promise<VerifiedHostKey | undefined>;
	insertIfAbsent(workspaceId: WorkspaceId, hostKey: VerifiedHostKey): Promise<boolean>;
}
