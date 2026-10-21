"use client";

import { useEffect, useMemo, useState } from "react";
import { mediaPreviewApi } from "../api/media-preview-api";
import type { MediaFile } from "../model/media-file";

export function useMediaFile(sessionId: string, path: string, revision: number) {
	const scope = useMemo(() => ({ sessionId, path, revision }), [sessionId, path, revision]);
	const [state, setState] = useState<{ scope: typeof scope; file: MediaFile | null; error: unknown }>({ scope, file: null, error: null });
	useEffect(() => {
		const request = new AbortController();
		setState({ scope, file: null, error: null });
		void mediaPreviewApi.inspect(scope.sessionId, scope.path, request.signal).then(
			(file) => { if (!request.signal.aborted) setState({ scope, file, error: null }); },
			(error: unknown) => { if (!request.signal.aborted) setState({ scope, file: null, error }); },
		);
		return () => request.abort();
	}, [scope]);
	return state.scope === scope ? state : { file: null, error: null };
}
