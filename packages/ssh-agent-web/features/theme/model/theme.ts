export const THEME_STORAGE_KEY = "ssh-agent-theme";

export type ThemePreference = "light" | "dark" | "contrast" | "system";
export type ResolvedTheme = "light" | "dark" | "contrast";

export function parseThemePreference(value: unknown): ThemePreference {
	return value === "light" || value === "dark" || value === "contrast" || value === "system" ? value : "system";
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
	if (preference === "system") return systemDark ? "dark" : "light";
	return preference;
}
