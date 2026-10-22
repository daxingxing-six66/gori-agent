"use client";

import { useEffect, useMemo, useState } from "react";
import { localFilesApi } from "@/features/chat/api/local-files-api";

/** Resolve the backend's effective default only when requested; never guess from Workspace defaults. */
export function useSessionWorkDir(sessionId: string, workDir: string | null, open: boolean) {
	const scope = useMemo(() => ({ sessionId, workDir }), [sessionId, workDir]);
	const [resolved, setResolved] = useState<{ scope: typeof scope; path?: string; failed?: boolean } | null>(null);
	const current = resolved?.scope === scope ? resolved : null;
	useEffect(() => {
		if (!open) { if (current?.failed) setResolved(null); return; }
		if (workDir || current) return;
		const request = new AbortController();
		void localFilesApi.listSession(sessionId, undefined, request.signal).then((listing) => {
			if (!request.signal.aborted) setResolved({ scope, path: listing.rootPath });
		}).catch(() => {
			if (!request.signal.aborted) setResolved({ scope, failed: true });
		});
		return () => request.abort();
	}, [current, open, scope, sessionId, workDir]);
	return { path: workDir ?? current?.path, failed: current?.failed === true };
}
