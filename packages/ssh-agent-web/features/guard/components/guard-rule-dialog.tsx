"use client";

import { ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import { GuardRuleSwitch } from "@/features/guard/components/guard-rule-switch";
import type { GuardMatch, UpdateGuardRuleInput } from "@/features/guard/model/guard";
import { hasGuardRuleErrors, validateGuardRule } from "@/features/guard/model/guard-editor-state";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";

const inputClass = "h-10 w-full rounded-lg border border-[var(--line)] bg-white px-3 text-[11px] text-zinc-800 outline-none transition focus:border-[#7aa48e] focus:ring-2 focus:ring-[#397b5c]/10";
export function GuardRuleDialog({ onClose, onCreate }: {
	onClose(): void;
	onCreate(rule: UpdateGuardRuleInput): Promise<void>;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const dialogRef = useRef<HTMLFormElement>(null);
	const onCloseRef = useRef(onClose);
	const submittingRef = useRef(false);
	const [displayName, setDisplayName] = useState("");
	const [match, setMatch] = useState<GuardMatch>("contains");
	const [pattern, setPattern] = useState("");
	const [reason, setReason] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [touched, setTouched] = useState({ displayName: false, pattern: false });
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const validation = validateGuardRule({ displayName, match, pattern });
	const invalid = hasGuardRuleErrors(validation);
	const matchOptions = [
		{ value: "contains", label: intl.formatMessage({ id: "guard.rule.match.contains" }) },
		{ value: "starts_with", label: intl.formatMessage({ id: "guard.rule.match.startsWith" }) },
		{ value: "regex", label: intl.formatMessage({ id: "guard.rule.match.regex" }) },
	];

	useEffect(() => {
		onCloseRef.current = onClose;
		submittingRef.current = submitting;
	}, [onClose, submitting]);

	useEffect(() => {
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !submittingRef.current) {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
		if (!submitting) onClose();
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setTouched({ displayName: true, pattern: true });
		if (invalid || submitting) return;
		setSubmitting(true);
		setError(null);
		void onCreate({
			displayName: displayName.trim(),
			match,
			pattern,
			...(reason.trim() ? { reason: reason.trim() } : {}),
			enabled,
		}).catch((requestError: unknown) => {
			setError(localizedErrorMessage(requestError));
		}).finally(() => setSubmitting(false));
	};

	return (
		<div className="management-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
			<form ref={dialogRef} className="management-dialog guard-rule-dialog" role="dialog" aria-modal="true" aria-labelledby="guard-rule-dialog-title" onSubmit={submit}>
				<header className="flex items-center justify-between gap-4 border-b border-[var(--line-soft)] px-6 py-5">
					<div className="flex items-center gap-3">
						<span className="grid h-9 w-9 place-items-center rounded-xl bg-[#eaf2ec] text-[#397b5c]"><ShieldCheck size={17} /></span>
						<h2 id="guard-rule-dialog-title" className="text-[15px] font-semibold tracking-[-0.02em]">{intl.formatMessage({ id: "guard.rule.dialog.title" })}</h2>
					</div>
					<button type="button" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40" disabled={submitting} onClick={close} aria-label={intl.formatMessage({ id: "common.close" })}><X size={17} /></button>
				</header>

				<div className="app-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
					{error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-5 text-rose-700" role="alert">{error}</p> : null}
					<div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
						<label className="block">
							<span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "guard.rule.name" })}</span>
							<input autoFocus className={inputClass} value={displayName} onBlur={() => setTouched((current) => ({ ...current, displayName: true }))} onChange={(event) => setDisplayName(event.target.value)} placeholder={intl.formatMessage({ id: "guard.rule.name.placeholder" })} />
							{touched.displayName && validation.displayName ? <span className="mt-1.5 block text-[9px] text-rose-600" role="alert">{intl.formatMessage({ id: "guard.rule.validation.nameRequired" })}</span> : null}
						</label>
						<div className="flex h-10 items-center justify-between gap-3 rounded-lg border border-[var(--line-soft)] bg-[#faf9f6] px-3 sm:w-[112px]">
							<span className="text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "guard.rule.dialog.enabled" })}</span>
							<GuardRuleSwitch checked={enabled} disabled={submitting} label={intl.formatMessage({ id: "guard.rule.enableNew" })} onChange={setEnabled} />
						</div>
					</div>

					<div className="grid gap-4 sm:grid-cols-[150px_minmax(0,1fr)]">
						<label className="block">
							<span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "guard.rule.match" })}</span>
							<CustomSelect ariaLabel={intl.formatMessage({ id: "guard.rule.match" })} value={match} disabled={submitting} onChange={(value) => setMatch(value as GuardMatch)} options={matchOptions} />
						</label>
						<label className="block">
							<span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "guard.rule.pattern" })}</span>
							<input className={`${inputClass} font-mono`} value={pattern} onBlur={() => setTouched((current) => ({ ...current, pattern: true }))} onChange={(event) => setPattern(event.target.value)} placeholder="shutdown" />
							{touched.pattern && validation.pattern ? <span className="mt-1.5 block text-[9px] text-rose-600" role="alert">{intl.formatMessage({ id: validation.pattern === "invalid_regex" ? "guard.rule.validation.regexInvalid" : "guard.rule.validation.patternRequired" })}</span> : null}
						</label>
					</div>

					<label className="block">
						<span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "guard.rule.reason" })} <span className="font-normal text-zinc-400">{intl.formatMessage({ id: "common.optional" })}</span></span>
						<input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={intl.formatMessage({ id: "guard.rule.reason.placeholder" })} />
					</label>
				</div>

				<footer className="flex justify-end gap-2 border-t border-[var(--line-soft)] px-6 py-4">
					<button type="button" className="h-9 rounded-lg border border-[var(--line)] px-4 text-[10px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40" disabled={submitting} onClick={close}>{intl.formatMessage({ id: "common.cancel" })}</button>
					<button type="submit" className="h-9 rounded-lg bg-[#397b5c] px-4 text-[10px] font-semibold text-white shadow-sm transition hover:bg-[#326e52] disabled:cursor-not-allowed disabled:opacity-45" disabled={invalid || submitting}>{intl.formatMessage({ id: submitting ? "guard.rule.dialog.adding" : "guard.rule.add" })}</button>
				</footer>
			</form>
		</div>
	);
}
