import type { Session } from "@/features/session/model/session";
import type { WorkspaceSessionTree } from "./workspace";

export type SessionUpdate = Pick<Session, "id" | "workspaceId" | "displayName" | "revision" | "updatedAt">;

export function parseSessionUpdate(value: unknown): SessionUpdate | null {
	if (value === null || typeof value !== "object") return null;
	const data = value as Record<string, unknown>;
	if (typeof data.id !== "string" || typeof data.workspaceId !== "string" ||
		typeof data.displayName !== "string" || !data.displayName.trim() || data.displayName.length > 120 ||
		typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 1 ||
		typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt)) return null;
	return { id: data.id, workspaceId: data.workspaceId, displayName: data.displayName, revision: data.revision, updatedAt: data.updatedAt };
}

export function applySessionUpdate(tree: WorkspaceSessionTree | null, update: SessionUpdate): WorkspaceSessionTree | null {
	if (!tree) return tree;
	return { workspaces: tree.workspaces.map((item) => item.workspace.id !== update.workspaceId ? item : {
		...item,
		sessions: item.sessions.map((session) => session.id === update.id && session.revision < update.revision
			? { ...session, ...update } : session),
	}) };
}

/** A tree request started before an SSE event must not roll the title back. */
export function mergeSessionUpdates(current: WorkspaceSessionTree | null, fetched: WorkspaceSessionTree): WorkspaceSessionTree {
	const previous = new Map(current?.workspaces.flatMap((item) => item.sessions.map((session) => [session.id, session] as const)));
	return { workspaces: fetched.workspaces.map((item) => ({ ...item, sessions: item.sessions.map((session) => {
		const newer = previous.get(session.id);
		return newer && newer.workspaceId === session.workspaceId && newer.revision > session.revision ? newer : session;
	}) })) };
}
