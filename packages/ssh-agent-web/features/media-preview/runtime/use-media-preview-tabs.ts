"use client";

import { useCallback, useMemo, useState } from "react";
import { mediaDocument, type MediaDocument } from "../model/media-file";

/** Media tabs own only preview state; no text-reader or task-container lifecycle is imported here. */
export function useMediaPreviewTabs(sessionId: string, workDir?: string | null) {
	const scope = useMemo(() => ({ sessionId, workDir }), [sessionId, workDir]);
	const [state, setState] = useState<{ scope: typeof scope; documents: MediaDocument[] }>({ scope, documents: [] });
	const open = useCallback((path: string) => {
		const document = mediaDocument(path, workDir);
		setState((current) => {
			const documents = current.scope === scope ? current.documents : [];
			return { scope, documents: documents.some((entry) => entry.id === document.id)
				? documents.map((entry) => entry.id === document.id ? { ...entry, revision: entry.revision + 1 } : entry)
				: [...documents, document] };
		});
		return document.id;
	}, [scope, workDir]);
	const close = useCallback((id: string) => setState((current) => current.scope === scope
		? { scope, documents: current.documents.filter((entry) => entry.id !== id) } : current), [scope]);
	return { documents: state.scope === scope ? state.documents : [], open, close };
}
