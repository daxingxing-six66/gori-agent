"use client";

import { usePathname } from "next/navigation";
import { useWorkspaceEvents } from "@/features/sftp/components/use-workspace-events";
import type { SessionUpdate } from "../model/session-update";
import type { WorkspaceSessionTree } from "../model/workspace";

export function WorkspaceSessionEvents({ tree, onSession, onReady }: {
	tree: WorkspaceSessionTree | null;
	onSession(update: SessionUpdate): void;
	onReady(): void;
}) {
	const pathname = usePathname();
	const segments = pathname.split("/").filter(Boolean);
	const id = segments[1] ? decodeURIComponent(segments[1]) : undefined;
	const workspaceId = segments[0] === "workspaces" ? id : segments[0] === "sessions"
		? tree?.workspaces.find((item) => item.sessions.some((session) => session.id === id))?.workspace.id : undefined;
	return workspaceId ? <SessionEvents key={workspaceId} workspaceId={workspaceId} onSession={onSession} onReady={onReady} /> : null;
}

function SessionEvents({ workspaceId, onSession, onReady }: {
	workspaceId: string;
	onSession(update: SessionUpdate): void;
	onReady(): void;
}) {
	useWorkspaceEvents(workspaceId, ["sessions"], { onSession, onReady });
	return null;
}
