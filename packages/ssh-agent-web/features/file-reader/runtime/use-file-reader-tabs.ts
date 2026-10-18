"use client";

import { useCallback, useMemo, useState } from "react";
import { readerDocument, type ReaderDocument } from "../model/reader-file";

/** Reader tabs have no terminal/deployment lifecycle or task-container dependency. */
export function useFileReaderTabs(sessionId: string, workDir?: string | null) {
	const scope = useMemo(() => ({ sessionId, workDir }), [sessionId, workDir]);
	const [state, setState] = useState<{ scope: typeof scope; documents: ReaderDocument[] }>({ scope, documents: [] });
	const documents = state.scope === scope ? state.documents : [];
	const open = useCallback((path: string) => {
		const document = readerDocument(path, workDir);
		setState((current) => {
			const documents = current.scope === scope ? current.documents : [];
			return { scope, documents: documents.some((entry) => entry.id === document.id)
				? documents.map((entry) => entry.id === document.id ? { ...entry, revision: entry.revision + 1 } : entry)
				: [...documents, document] };
		});
		return document.id;
	}, [scope, workDir]);
	const close = useCallback((id: string) => {
		setState((current) => current.scope !== scope ? current : { scope, documents: current.documents.filter((entry) => entry.id !== id) });
	}, [scope]);
	return { documents, open, close };
}
