"use client";

import { X } from "lucide-react";
import { useEffect, type FormEvent, type ReactNode } from "react";
import { useIntl } from "react-intl";

export function ManagementDialog({
	title,
	description,
	children,
	onClose,
	onSubmit,
	submitLabel,
	submitting,
	submitDisabled = false,
	footerLeading,
	footerNotice,
}: {
	title: string;
	description?: string;
	children: ReactNode;
	onClose(): void;
	onSubmit(event: FormEvent<HTMLFormElement>): void;
	submitLabel: string;
	submitting: boolean;
	submitDisabled?: boolean;
	footerLeading?: ReactNode;
	footerNotice?: ReactNode;
}) {
	const intl = useIntl();
	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	return (
		<div className="management-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<form className="management-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit}>
				<header className="flex items-start justify-between gap-4 border-b border-[var(--line-soft)] px-5 py-4">
					<div><h2 className="text-[14px] font-semibold">{title}</h2>{description ? <p className="mt-1 text-[10px] leading-5 text-zinc-500">{description}</p> : null}</div>
					<button type="button" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" onClick={onClose} aria-label={intl.formatMessage({ id: "common.close" })}><X size={16} /></button>
				</header>
				<div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">{children}</div>
				<footer className="shrink-0 border-t border-[var(--line-soft)] px-5 py-4">
					{footerNotice ? <div className="mb-3">{footerNotice}</div> : null}
					<div className="flex flex-wrap items-center justify-end gap-2">
						{footerLeading ? <div className="mr-auto">{footerLeading}</div> : null}
						<div className="ml-auto flex items-center gap-2">
							<button type="button" className="h-9 rounded-lg border border-[var(--line)] px-4 text-[10px] font-semibold text-zinc-600 hover:bg-zinc-50" onClick={onClose}>{intl.formatMessage({ id: "common.cancel" })}</button>
							<button type="submit" className="h-9 rounded-lg bg-[#397b5c] px-4 text-[10px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={submitting || submitDisabled}>{submitting ? intl.formatMessage({ id: "common.submitting" }) : submitLabel}</button>
						</div>
					</div>
				</footer>
			</form>
		</div>
	);
}

export function DialogField({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string }) {
	return <label className="block"><span className="mb-1.5 block text-[9px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{label}</span>{children}{error ? <span className="mt-1 block text-[9px] leading-4 text-rose-600" role="alert">{error}</span> : hint ? <span className="mt-1 block text-[9px] leading-4 text-zinc-400">{hint}</span> : null}</label>;
}

export function DialogError({ message }: { message: string | null }) {
	return message ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-5 text-rose-700" role="alert">{message}</p> : null;
}

export const dialogInputClass = "h-10 w-full rounded-lg border border-[var(--line)] bg-white px-3 text-[11px] text-zinc-800 outline-none focus:border-[#7aa48e]";
export const dialogTextareaClass = "min-h-28 w-full resize-y rounded-lg border border-[var(--line)] bg-white px-3 py-2 font-mono text-[10px] leading-5 text-zinc-800 outline-none focus:border-[#7aa48e]";
