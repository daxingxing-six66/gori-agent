"use client";

import { createContext, useContext } from "react";
import type { ResolvedTheme, ThemePreference } from "@/features/theme/model/theme";

export interface ThemeContextValue {
	preference: ThemePreference;
	resolvedTheme: ResolvedTheme;
	setPreference(value: ThemePreference): void;
}
export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
	const value = useContext(ThemeContext);
	if (value === null) throw new Error("useTheme must be used inside ThemeProvider");
	return value;
}
