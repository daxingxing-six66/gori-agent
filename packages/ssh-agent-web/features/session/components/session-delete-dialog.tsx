"use client";

import { MessageSquareText, Trash2, X } from "lucide-react";
import { useEffect, useRef, type FormEvent } from "react";
import { useIntl } from "react-intl";
import type { Session } from "@/features/session/model/session";

export function SessionDeleteDialog({ session, deleting, error, onClose, onConfirm }: {
	session: Session;
	deleting: boolean;
	error?: string;
	onClose(): void;
	onConfirm(): Promise<void>;
}) {
	const intl = useIntl();
	const dialogRef = useRef<HTMLFormElement>(null);
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const onCloseRef = useRef(onClose);
	const deletingRef = useRef(deleting);

	useEffect(() => {
		onCloseRef.current = onClose;
		deletingRef.current = deleting;
	}, [deleting, onClose]);

	useEffect(() => {
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		cancelButtonRef.current?.focus();
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !deletingRef.current) {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
			);
			if (!focusable || focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			previousFocus?.focus();
		};
	}, []);

	const close = () => {
		if (!deleting) onClose();
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!deleting) void onConfirm();
	};

	return (
		<div className="management-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
			<form ref={dialogRef} className="management-dialog w-full max-w-[440px]" role="dialog" aria-modal="true" aria-labelledby="session-delete-dialog-title" aria-describedby="session-delete-dialog-description" onSubmit={submit}>
				<header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
					<div className="flex items-center gap-3">
						<span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600"><Trash2 size={18} /></span>
						<div><h2 id="session-delete-dialog-title" className="text-[15px] font-semibold tracking-[-0.02em] text-zinc-900">{intl.formatMessage({ id: "session.delete.title" })}</h2><p className="mt-1 text-[10px] text-zinc-400">{intl.formatMessage({ id: "session.delete.subtitle" })}</p></div>
					</div>
					<button type="button" className="rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40" disabled={deleting} onClick={close} aria-label={intl.formatMessage({ id: "common.close" })}><X size={17} /></button>
				</header>

				<div className="px-6 pb-6 pt-3">
					<div className="flex items-center gap-3 rounded-xl border border-[var(--line-soft)] bg-[#f7f6f2] px-4 py-3">
						<span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-zinc-500 shadow-sm"><MessageSquareText size={16} /></span>
						<div className="min-w-0"><p className="truncate text-[11px] font-semibold text-zinc-800">{session.displayName}</p><p className="mt-1 font-mono text-[9px] text-zinc-400">Session · {session.id.slice(0, 8)}</p></div>
					</div>
					<p id="session-delete-dialog-description" className="mt-4 text-[10px] leading-5 text-zinc-500">{intl.formatMessage({ id: "session.delete.description" })}</p>
					{error ? <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-5 text-rose-700" role="alert">{error}</p> : null}
				</div>

				<footer className="flex justify-end gap-2 border-t border-[var(--line-soft)] px-6 py-4">
					<button ref={cancelButtonRef} type="button" className="h-9 rounded-lg border border-[var(--line)] px-4 text-[10px] font-semibold text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40" disabled={deleting} onClick={close}>{intl.formatMessage({ id: "common.cancel" })}</button>
					<button type="submit" className="h-9 rounded-lg bg-rose-600 px-4 text-[10px] font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-45" disabled={deleting}>{intl.formatMessage({ id: deleting ? "session.delete.deleting" : "session.delete.permanent" })}</button>
				</footer>
			</form>
		</div>
	);
}
