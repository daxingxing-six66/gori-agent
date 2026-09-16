"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { workspaceApi } from "@/features/workspace/api/workspace-api";
import { WorkspaceTreeContext } from "@/features/workspace/components/workspace-tree-context";
import type { WorkspaceSessionTree } from "@/features/workspace/model/workspace";
import { ApiError } from "@/shared/errors/api-error";

export function WorkspaceTreeProvider({ children }: { children: React.ReactNode }) {
	const [tree, setTree] = useState<WorkspaceSessionTree | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<ApiError | null>(null);

	const load = useCallback(async (signal?: AbortSignal) => {
		try {
			setTree(await workspaceApi.getTree(signal));
			setError(null);
		} catch (requestError) {
			if (signal?.aborted) return;
			setError(
				requestError instanceof ApiError
					? requestError
					: new ApiError(0, "network_error", ""),
			);
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		workspaceApi.getTree(controller.signal).then((result) => {
			setTree(result);
			setError(null);
		}).catch((requestError: unknown) => {
			if (!controller.signal.aborted) setError(requestError instanceof ApiError ? requestError : new ApiError(0, "network_error", ""));
		}).finally(() => {
			if (!controller.signal.aborted) setLoading(false);
		});
		return () => controller.abort();
	}, []);

	const value = useMemo(
		() => ({ tree, loading, error, refresh: () => load() }),
		[tree, loading, error, load],
	);
	return <WorkspaceTreeContext.Provider value={value}>{children}</WorkspaceTreeContext.Provider>;
}
