"use client";

import { useCallback, useMemo, useState } from "react";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import { attachmentReaderDocument, readerDocument, type ReaderDocument } from "../model/reader-file";

/** Reader tabs have no terminal/deployment lifecycle or task-container dependency. */
export function useFileReaderTabs(sessionId: string, workDir?: string | null) {
	const scope = useMemo(() => ({ sessionId, workDir }), [sessionId, workDir]);
	const [state, setState] = useState<{ scope: typeof scope; documents: ReaderDocument[] }>({ scope, documents: [] });
	const documents = state.scope === scope ? state.documents : [];
	const openDocument = useCallback((document: ReaderDocument) => {
		setState((current) => {
			const documents = current.scope === scope ? current.documents : [];
			return { scope, documents: documents.some((entry) => entry.id === document.id)
				? documents.map((entry) => entry.id === document.id ? { ...entry, revision: entry.revision + 1 } : entry)
				: [...documents, document] };
		});
		return document.id;
	}, [scope]);
	const open = useCallback((path: string) => openDocument(readerDocument(path, workDir)), [openDocument, workDir]);
	const openAttachment = useCallback((attachment: SessionAttachment) => {
		if (attachment.sessionId !== sessionId) return null;
		return openDocument(attachmentReaderDocument(attachment));
	}, [openDocument, sessionId]);
	const close = useCallback((id: string) => {
		setState((current) => current.scope !== scope ? current : { scope, documents: current.documents.filter((entry) => entry.id !== id) });
	}, [scope]);
	return { documents, open, openAttachment, close };
}
