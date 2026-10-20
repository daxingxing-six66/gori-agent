"use client";
import { useEffect, useLayoutEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { diagnoseApi } from "../api/diagnose-api";
import { DiagnoseMarkdown } from "./diagnose-markdown";

export function DiagnoseConclusionPage({ sessionId, taskId, onContentReady }: { sessionId: string; taskId: string; onContentReady?(): void }) {
	const intl = useIntl(); const localize = useLocalizedErrorMessage();
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let disposed = false; setError(null); setMarkdown(null);
		void diagnoseApi.conclusion(sessionId, taskId).then((value) => { if (!disposed) setMarkdown(value); }, (failure) => { if (!disposed) setError(failure); });
		return () => { disposed = true; };
	}, [sessionId, taskId, attempt]);
	useLayoutEffect(() => { if (markdown !== null) onContentReady?.(); }, [markdown, onContentReady]);
	return <div className="diagnose-conclusion">{error ? <div role="alert"><p>{localize(error)}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>{intl.formatMessage({ id: "diagnose.retry" })}</button></div>
		: markdown === null ? <p role="status">{intl.formatMessage({ id: "diagnose.loading" })}</p> : <DiagnoseMarkdown content={markdown} />}</div>;
}
