"use client";

import { useEffect, useState } from "react";
import { localFilesApi, type LocalFileSearchResult } from "@/features/chat/api/local-files-api";

interface SearchState extends LocalFileSearchResult { key: string; loading: boolean; error: unknown }
const emptyResult: LocalFileSearchResult = { entries: [], truncated: false, incomplete: false };

/** Owns debounce, request identity and cancellation, independently of the contenteditable DOM. */
export function useLocalFileSearch(sessionId: string | undefined, query: string, enabled: boolean) {
	const [ignored, setIgnored] = useState({ sessionId, enabled: false });
	const includeIgnored = ignored.sessionId === sessionId && ignored.enabled;
	const key = JSON.stringify([sessionId, query, includeIgnored]);
	const [refreshRequest, setRefreshRequest] = useState({ key: "", revision: 0 });
	const revision = refreshRequest.key === key ? refreshRequest.revision : 0;
	const [state, setState] = useState<SearchState>({ ...emptyResult, key: "", loading: false, error: null });
	const active = enabled && !!sessionId && !!query.trim();

	useEffect(() => {
		if (!active || !sessionId) return;
		const controller = new AbortController();
		setState({ ...emptyResult, key, loading: true, error: null });
		const timeout = window.setTimeout(() => {
			void localFilesApi.searchSession(sessionId, query, { signal: controller.signal, includeIgnored, refresh: revision > 0 })
				.then((result) => { if (!controller.signal.aborted) setState({ ...result, key, loading: false, error: null }); })
				.catch((error: unknown) => { if (!controller.signal.aborted) setState({ ...emptyResult, key, loading: false, error }); });
		}, 180);
		return () => { window.clearTimeout(timeout); controller.abort(); };
	}, [active, sessionId, query, key, includeIgnored, revision]);

	return {
		...(!active ? { ...emptyResult, loading: false, error: null } : state.key !== key ? { ...emptyResult, loading: true, error: null } : state),
		includeIgnored,
		toggleIgnored: () => setIgnored({ sessionId, enabled: !includeIgnored }),
		refresh: () => setRefreshRequest((current) => ({ key, revision: current.revision + 1 })),
	};
}
