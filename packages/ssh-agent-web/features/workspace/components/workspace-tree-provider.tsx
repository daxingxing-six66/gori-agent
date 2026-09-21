"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workspaceApi } from "@/features/workspace/api/workspace-api";
import { applySessionUpdate, mergeSessionUpdates, type SessionUpdate } from "../model/session-update";
import { WorkspaceSessionEvents } from "./workspace-session-events";
import { WorkspaceTreeContext } from "@/features/workspace/components/workspace-tree-context";
import type { WorkspaceSessionTree } from "@/features/workspace/model/workspace";
import { ApiError } from "@/shared/errors/api-error";

export function WorkspaceTreeProvider({ children }: { children: React.ReactNode }) {
	const loadVersion = useRef(0);
	const [tree, setTree] = useState<WorkspaceSessionTree | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<ApiError | null>(null);
	const [workspaceExpansion, setWorkspaceExpansion] = useState<Record<string, boolean>>({});
	const setWorkspaceExpanded = useCallback((workspaceId: string, expanded: boolean) => {
		setWorkspaceExpansion((current) => current[workspaceId] === expanded ? current : { ...current, [workspaceId]: expanded });
	}, []);

	const load = useCallback(async (signal?: AbortSignal) => {
		const version = ++loadVersion.current;
		try {
			const result = await workspaceApi.getTree(signal);
			if (signal?.aborted || version !== loadVersion.current) return;
			setTree((current) => mergeSessionUpdates(current, result));
			setError(null);
		} catch (requestError) {
			if (signal?.aborted || version !== loadVersion.current) return;
			setError(
				requestError instanceof ApiError
					? requestError
					: new ApiError(0, "network_error", ""),
			);
		} finally {
			if (!signal?.aborted && version === loadVersion.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const onSession = useCallback((update: SessionUpdate) => {
		setTree((current) => applySessionUpdate(current, update));
	}, []);
	const onReady = useCallback(() => { void load(); }, [load]);

	const value = useMemo(
		() => ({ tree, loading, error, refresh: () => load(), workspaceExpansion, setWorkspaceExpanded }),
		[tree, loading, error, load, workspaceExpansion, setWorkspaceExpanded],
	);
	return <WorkspaceTreeContext.Provider value={value}><WorkspaceSessionEvents tree={tree} onSession={onSession} onReady={onReady} />{children}</WorkspaceTreeContext.Provider>;
}
