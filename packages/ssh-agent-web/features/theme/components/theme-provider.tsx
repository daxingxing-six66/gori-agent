"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext, type ThemeContextValue } from "@/features/theme/components/theme-context";
import {
	parseThemePreference,
	resolveTheme,
	THEME_STORAGE_KEY,
	type ThemePreference,
} from "@/features/theme/model/theme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function initialPreference(): ThemePreference {
	if (typeof document === "undefined") return "system";
	return parseThemePreference(document.documentElement.dataset.themePreference);
}
function initialSystemDark(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [preference, setPreference] = useState<ThemePreference>(initialPreference);
	const [systemDark, setSystemDark] = useState(initialSystemDark);
	const resolvedTheme = resolveTheme(preference, systemDark);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia(DARK_MEDIA_QUERY);
		const update = (event: MediaQueryListEvent | MediaQueryList): void => setSystemDark(event.matches);
		update(media);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		const root = document.documentElement;
		root.dataset.theme = resolvedTheme;
		root.dataset.themePreference = preference;
		root.style.colorScheme = resolvedTheme;
		try {
			localStorage.setItem(THEME_STORAGE_KEY, preference);
		} catch {
			// Browsers may deny storage access; the in-memory preference still applies.
		}
	}, [preference, resolvedTheme]);

	const value = useMemo<ThemeContextValue>(
		() => ({ preference, resolvedTheme, setPreference }),
		[preference, resolvedTheme],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
