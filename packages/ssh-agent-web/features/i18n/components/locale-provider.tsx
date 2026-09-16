"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { IntlProvider } from "react-intl";
import { LocaleContext, type LocaleContextValue } from "@/features/i18n/components/locale-context";
import { messagesByLocale } from "@/features/i18n/messages/messages";
import { localeCookie, localeDirection, type SupportedLocale } from "@/features/i18n/model/locale";

export function LocaleProvider({ initialLocale, children }: { initialLocale: SupportedLocale; children: ReactNode }) {
	const [locale, setLocaleState] = useState(initialLocale);
	const setLocale = useCallback((nextLocale: SupportedLocale) => {
		applyLocaleDocument(nextLocale);
		setLocaleState(nextLocale);
	}, []);

	useEffect(() => {
		applyLocaleDocument(locale);
	}, [locale]);

	const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale }), [locale, setLocale]);

	return (
		<LocaleContext.Provider value={value}>
			<IntlProvider locale={locale} defaultLocale="zh-CN" messages={messagesByLocale[locale]}>
				{children}
			</IntlProvider>
		</LocaleContext.Provider>
	);
}

function applyLocaleDocument(locale: SupportedLocale): void {
	const root = document.documentElement;
	root.lang = locale;
	root.dir = localeDirection(locale);
	root.dataset.locale = locale;
	document.cookie = localeCookie(locale, window.location.protocol === "https:");
}
