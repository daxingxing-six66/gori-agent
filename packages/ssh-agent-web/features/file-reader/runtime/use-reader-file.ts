"use client";

import { useEffect, useState } from "react";
import { fileReaderApi, type ReaderFile } from "../api/file-reader-api";

export function useReaderFile(sessionId: string, path: string, revision: number) {
	const [retry, setRetry] = useState(0);
	const [state, setState] = useState<{ file: ReaderFile | null; loading: boolean; error: unknown }>({ file: null, loading: true, error: null });
	useEffect(() => {
		const request = new AbortController();
		setState((current) => ({ ...current, loading: true, error: null }));
		void fileReaderApi.read(sessionId, path, request.signal).then(
			(file) => { if (!request.signal.aborted) setState({ file, loading: false, error: null }); },
			(error: unknown) => { if (!request.signal.aborted) setState({ file: null, loading: false, error }); },
		);
		return () => request.abort();
	}, [sessionId, path, revision, retry]);
	return { ...state, refresh: () => setRetry((value) => value + 1) };
}
