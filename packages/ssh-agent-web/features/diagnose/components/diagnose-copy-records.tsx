"use client";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { readDiagnoseRecordsJson } from "../api/read-diagnose-records";

export function DiagnoseCopyRecords({ sessionId, taskId }: { sessionId: string; taskId: string }) {
	const intl = useIntl();
	const request = useRef<AbortController | null>(null);
	const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
	useEffect(() => () => { request.current?.abort(); }, [sessionId, taskId]);
	useEffect(() => {
		if (status !== "copied") return;
		const timer = setTimeout(() => setStatus("idle"), 1500);
		return () => clearTimeout(timer);
	}, [status]);
	const copy = async () => {
		if (request.current) return;
		const controller = new AbortController(); request.current = controller;
		setStatus("copying");
		try {
			const json = await readDiagnoseRecordsJson(sessionId, taskId, controller.signal);
			controller.signal.throwIfAborted();
			await navigator.clipboard.writeText(json);
			if (!controller.signal.aborted) setStatus("copied");
		} catch {
			if (!controller.signal.aborted) setStatus("failed");
		} finally { if (request.current === controller) request.current = null; }
	};
	const Icon = status === "copying" ? LoaderCircle : status === "copied" ? Check : Copy;
	const label = intl.formatMessage({ id: status === "copying" ? "diagnose.copying" : status === "copied" ? "diagnose.copied" : "diagnose.copy" });
	return <div className="diagnose-copy-records">
		{status === "failed" ? <span role="alert">{intl.formatMessage({ id: "diagnose.copyFailed" })}</span> : null}
		<button type="button" disabled={status === "copying"} onClick={() => { void copy(); }} aria-busy={status === "copying"}>
			<Icon size={12} aria-hidden="true" className={status === "copying" ? "animate-spin" : undefined} /><span role="status">{label}</span>
		</button>
	</div>;
}
