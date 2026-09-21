"use client";

import { createContext, useContext } from "react";
import type { WorkspaceSessionTree } from "@/features/workspace/model/workspace";
import type { ApiError } from "@/shared/errors/api-error";

export interface WorkspaceTreeContextValue {
	tree: WorkspaceSessionTree | null;
	loading: boolean;
	error: ApiError | null;
	refresh(): Promise<void>;
	workspaceExpansion: Record<string, boolean>;
	setWorkspaceExpanded(workspaceId: string, expanded: boolean): void;
}

export const WorkspaceTreeContext = createContext<WorkspaceTreeContextValue | null>(null);

export function useWorkspaceTree(): WorkspaceTreeContextValue {
	const value = useContext(WorkspaceTreeContext);
	if (value === null) throw new Error("useWorkspaceTree must be used inside WorkspaceTreeProvider");
	return value;
}
