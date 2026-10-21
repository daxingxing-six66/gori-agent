"use client";

import { CircleAlert, FileText, LoaderCircle, X } from "lucide-react";
import { useIntl } from "react-intl";
import { formatAttachmentBytes } from "@/features/session/model/attachment-file";

export function ChatDocumentAttachment({ name, size, onOpen, disabled = false, status = "uploaded", error, onRemove }: {
	name: string;
	size: number;
	onOpen?(): void;
	disabled?: boolean;
	status?: "preparing" | "uploading" | "uploaded" | "error";
	error?: string | null;
	onRemove?(): void;
}) {
	const intl = useIntl();
	const loading = status === "preparing" || status === "uploading";
	return <div className={`relative flex w-56 max-w-full items-center rounded-xl border bg-[var(--surface-muted)] ${error ? "border-[var(--danger)]" : "border-[var(--line-soft)]"}`}>
		<button type="button" disabled={disabled || loading || status === "error" || !onOpen} onClick={onOpen}
			className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-3 text-left transition hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
			aria-label={intl.formatMessage({ id: "chat.attachment.document.open" }, { name })} title={error ?? name}>
			{loading ? <LoaderCircle size={21} className="shrink-0 animate-spin text-[var(--accent)]" /> : status === "error" ? <CircleAlert size={21} className="shrink-0 text-[var(--danger)]" /> : <FileText size={21} className="shrink-0 text-[var(--accent)]" />}
			<span className="min-w-0"><span className="block truncate text-[11px] font-semibold text-[var(--ink)]">{name}</span>
				<span className="mt-1 block text-[9px] text-[var(--text-muted)]">{formatAttachmentBytes(size)} · {intl.formatMessage({ id: loading ? "chat.attachment.uploading" : status === "error" ? "chat.attachment.failed" : "chat.attachment.document.label" })}</span>
			</span>
		</button>
		{onRemove ? <button type="button" onClick={onRemove} className="mr-2 grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" aria-label={intl.formatMessage({ id: "chat.attachment.remove" }, { name })}><X size={13} /></button> : null}
	</div>;
}
