"use client";

import { createContext, useContext } from "react";
import type { SupportedLocale } from "@/features/i18n/model/locale";

export interface LocaleContextValue {
	locale: SupportedLocale;
	setLocale(locale: SupportedLocale): void;
}

export const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale(): LocaleContextValue {
	const value = useContext(LocaleContext);
	if (value === null) throw new Error("useLocale must be used inside LocaleProvider");
	return value;
}
