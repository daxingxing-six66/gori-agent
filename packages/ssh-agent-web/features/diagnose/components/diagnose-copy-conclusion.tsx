"use client";
import { Check, CircleAlert, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

export function DiagnoseCopyConclusion({ markdown }: { markdown: string }) {
	const intl = useIntl();
	const request = useRef<object | null>(null);
	const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
	useEffect(() => () => { request.current = null; }, []);
	useEffect(() => {
		if (status !== "copied") return;
		const timer = setTimeout(() => setStatus("idle"), 1500);
		return () => clearTimeout(timer);
	}, [status]);
	const copy = async () => {
		if (request.current) return;
		const current = {}; request.current = current;
		setStatus("copying");
		try {
			await navigator.clipboard.writeText(markdown);
			if (request.current === current) setStatus("copied");
		} catch {
			if (request.current === current) setStatus("failed");
		} finally { if (request.current === current) request.current = null; }
	};
	const Icon = status === "copying" ? LoaderCircle : status === "copied" ? Check : status === "failed" ? CircleAlert : Copy;
	const label = intl.formatMessage({ id: status === "copying" ? "diagnose.copying" : status === "copied" ? "diagnose.copied" : status === "failed" ? "diagnose.copyFailed" : "diagnose.copyConclusion" });
	return <div className="diagnose-conclusion-tools">
		<button type="button" className="diagnose-copy-conclusion" data-status={status} disabled={status === "copying"}
			onClick={() => { void copy(); }} aria-label={label} title={label} aria-busy={status === "copying"}>
			<Icon size={14} aria-hidden="true" className={status === "copying" ? "animate-spin" : undefined} />
		</button>
		<span className="sr-only" role="status">{status === "idle" ? "" : label}</span>
	</div>;
}
