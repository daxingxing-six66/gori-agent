"use client";

import { Check, Languages } from "lucide-react";
import { useIntl } from "react-intl";
import { useLocale } from "@/features/i18n/components/locale-context";
import { LOCALE_METADATA, SUPPORTED_LOCALES } from "@/features/i18n/model/locale";

export function LanguageSelector() {
	const intl = useIntl();
	const { locale, setLocale } = useLocale();
	return (
		<section className="space-y-4">
			<div>
				<p className="text-[12px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "language.title" })}</p>
				<p className="mt-1.5 max-w-[620px] text-[10px] leading-5 text-[var(--text-muted)]">{intl.formatMessage({ id: "language.description" })}</p>
			</div>
			<fieldset className="grid max-w-[520px] gap-3 sm:grid-cols-2" aria-label={intl.formatMessage({ id: "language.options" })}>
				{SUPPORTED_LOCALES.map((option) => {
					const selected = locale === option;
					return (
						<label key={option} className="group flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3.5 transition hover:border-[var(--line-strong)] data-[selected=true]:border-[var(--accent)] data-[selected=true]:bg-[var(--accent-soft)]" data-selected={selected ? "true" : "false"}>
							<input type="radio" className="sr-only" name="locale" value={option} checked={selected} onChange={() => setLocale(option)} />
							<span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-muted)] text-[var(--text-muted)] group-data-[selected=true]:text-[var(--accent-ink)]"><Languages size={15} /></span>
							<span className="min-w-0 flex-1"><span className="block text-[11px] font-semibold text-[var(--ink)]">{LOCALE_METADATA[option].nativeName}</span><span className="mt-1 block text-[9px] text-[var(--text-muted)]">{intl.formatMessage({ id: `language.${option}.description` })}</span></span>
							{selected ? <Check size={14} className="shrink-0 text-[var(--accent-ink)]" /> : null}
						</label>
					);
				})}
			</fieldset>
		</section>
	);
}
