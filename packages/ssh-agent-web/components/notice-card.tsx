"use client";

import { CircleAlert, Info, LoaderCircle, X } from "lucide-react";
import { useIntl } from "react-intl";

export function NoticeCard({ message, tone, loading = false, onDismiss }: { message: string; tone: "error" | "info"; loading?: boolean; onDismiss?(): void }) {
	const intl = useIntl();
	const error = tone === "error";
	const Icon = loading ? LoaderCircle : error ? CircleAlert : Info;
	return (
		<div className={`flex w-full items-start gap-2.5 rounded-xl border bg-[var(--surface)] px-3 py-2.5 ${error ? "border-[var(--danger-line)]" : "border-[var(--accent)]/30"}`}>
			<Icon size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${loading ? "motion-safe:animate-spin" : ""} ${error ? "text-[var(--danger)]" : "text-[var(--accent)]"}`} />
			<p role={error ? "alert" : "status"} className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] leading-5 text-[var(--ink)] [overflow-wrap:anywhere]">{message}</p>
			{!loading && onDismiss ? <button type="button" onClick={onDismiss} aria-label={intl.formatMessage({ id: "common.close" })} title={intl.formatMessage({ id: "common.close" })} className="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
				<X size={14} aria-hidden="true" />
			</button> : null}
		</div>
	);
}
