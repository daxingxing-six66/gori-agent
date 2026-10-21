"use client";

import { useEffect, useMemo, useState } from "react";
import { fileReaderApi, type ReaderFile } from "../api/file-reader-api";
import type { ReaderSource } from "../model/reader-file";

export function useReaderFile(sessionId: string, source: ReaderSource, revision: number) {
	const [retry, setRetry] = useState(0);
	const reference = source.kind === "local" ? source.path : source.attachmentId;
	const scope = useMemo(() => ({ sessionId, kind: source.kind, reference }), [sessionId, source.kind, reference]);
	const [state, setState] = useState<{ scope: typeof scope; file: ReaderFile | null; loading: boolean; error: unknown }>({ scope, file: null, loading: true, error: null });
	useEffect(() => {
		const request = new AbortController();
		setState((current) => ({ scope, file: current.scope === scope ? current.file : null, loading: true, error: null }));
		const read = scope.kind === "attachment" ? fileReaderApi.readAttachment : fileReaderApi.read;
		void read(scope.sessionId, scope.reference, request.signal).then(
			(file) => { if (!request.signal.aborted) setState({ scope, file, loading: false, error: null }); },
			(error: unknown) => { if (!request.signal.aborted) setState({ scope, file: null, loading: false, error }); },
		);
		return () => request.abort();
	}, [scope, revision, retry]);
	const visible = state.scope === scope ? state : { file: null, loading: true, error: null };
	return { file: visible.file, loading: visible.loading, error: visible.error, refresh: () => setRetry((value) => value + 1) };
}
