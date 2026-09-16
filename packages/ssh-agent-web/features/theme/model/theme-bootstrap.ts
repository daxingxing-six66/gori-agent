import { THEME_STORAGE_KEY } from "@/features/theme/model/theme";

export const THEME_BOOTSTRAP_SCRIPT = `(() => {
	let preference = "system";
	try {
		const stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
		if (stored === "light" || stored === "dark" || stored === "system") preference = stored;
	} catch {}
	let systemDark = false;
	try { systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch {}
	const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
	const root = document.documentElement;
	root.dataset.theme = resolved;
	root.dataset.themePreference = preference;
	root.style.colorScheme = resolved;
})();`;
