import { createElement } from "react";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { zhCNMessages } from "../features/i18n/messages/zh-CN.ts";
import { ThemePreferenceControl } from "../features/theme/components/theme-selector.tsx";
import { THEME_BOOTSTRAP_SCRIPT } from "../features/theme/model/theme-bootstrap.ts";
import {
	parseThemePreference,
	resolveTheme,
	THEME_STORAGE_KEY,
	type ThemePreference,
} from "../features/theme/model/theme.ts";

describe("theme state", () => {
	it("defaults invalid and missing preferences to system", () => {
		expect(parseThemePreference(undefined)).toBe("system");
		expect(parseThemePreference("sepia")).toBe("system");
		expect(parseThemePreference("light")).toBe("light");
		expect(parseThemePreference("dark")).toBe("dark");
		expect(parseThemePreference("contrast")).toBe("contrast");
	});

	it("resolves only the system preference from the media state", () => {
		expect(resolveTheme("system", false)).toBe("light");
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
		expect(resolveTheme("contrast", true)).toBe("contrast");
		expect(resolveTheme("contrast", false)).toBe("contrast");
	});

	it("bootstraps the same storage and document attribute contract before hydration", () => {
		expect(THEME_BOOTSTRAP_SCRIPT).toContain(THEME_STORAGE_KEY);
		expect(THEME_BOOTSTRAP_SCRIPT).toContain("themePreference");
		expect(THEME_BOOTSTRAP_SCRIPT).toContain("prefers-color-scheme: dark");
		expect(THEME_BOOTSTRAP_SCRIPT).toContain("style.colorScheme");
	});

	it.each([
		["light", true, "light", "light"],
		["dark", false, "dark", "dark"],
		["contrast", true, "contrast", "light"],
		["contrast", false, "contrast", "light"],
		["system", true, "dark", "dark"],
		["system", false, "light", "light"],
	] as const)("restores %s before hydration with system dark=%s", (preference, systemDark, resolved, colorScheme) => {
		const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
		runInNewContext(THEME_BOOTSTRAP_SCRIPT, {
			localStorage: { getItem: () => preference },
			window: { matchMedia: () => ({ matches: systemDark }) },
			document: { documentElement: root },
		});
		expect(root.dataset.themePreference).toBe(preference);
		expect(root.dataset.theme).toBe(resolved);
		expect(root.style.colorScheme).toBe(colorScheme);
	});

	it("renders the three visual themes plus system following without descriptive copy", () => {
		const markup = renderToStaticMarkup(createElement(IntlProvider, {
			locale: "zh-CN",
			messages: zhCNMessages,
		}, createElement(ThemePreferenceControl, {
				preference: "system",
				resolvedTheme: "dark",
				onChange: () => undefined,
			}),
		));
		expect(markup.match(/type="radio"/g)).toHaveLength(4);
		expect(markup).toContain("value=\"light\"");
		expect(markup).toContain("value=\"dark\"");
		expect(markup).toContain("value=\"contrast\"");
		expect(markup).toContain("明暗分层 · 实验");
		expect(markup).not.toContain("theme-option-description");
		expect(markup).toMatch(/checked="" value="system"|value="system" checked=""/);
		expect(markup).toContain("当前使用暗部");
	});

	it.each(["light", "dark", "contrast", "system"] satisfies ThemePreference[])("selects only the %s preference", (preference) => {
		const markup = renderToStaticMarkup(createElement(IntlProvider, {
			locale: "zh-CN", messages: zhCNMessages,
		}, createElement(ThemePreferenceControl, { preference, resolvedTheme: resolveTheme(preference, false), onChange: () => undefined })));
		expect(markup.match(/checked=""/g)).toHaveLength(1);
		const selectedInput = markup.match(/<input[^>]*checked=""[^>]*>/)?.[0];
		expect(selectedInput).toContain(`value="${preference}"`);
	});
});
