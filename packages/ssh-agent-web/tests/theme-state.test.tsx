import { createElement } from "react";
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
} from "../features/theme/model/theme.ts";

describe("theme state", () => {
	it("defaults invalid and missing preferences to system", () => {
		expect(parseThemePreference(undefined)).toBe("system");
		expect(parseThemePreference("sepia")).toBe("system");
		expect(parseThemePreference("light")).toBe("light");
		expect(parseThemePreference("dark")).toBe("dark");
	});

	it("resolves only the system preference from the media state", () => {
		expect(resolveTheme("system", false)).toBe("light");
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});

	it("bootstraps the same storage and document attribute contract before hydration", () => {
		expect(THEME_BOOTSTRAP_SCRIPT).toContain(THEME_STORAGE_KEY);
		expect(THEME_BOOTSTRAP_SCRIPT).toContain("themePreference");
		expect(THEME_BOOTSTRAP_SCRIPT).toContain("prefers-color-scheme: dark");
		expect(THEME_BOOTSTRAP_SCRIPT).toContain("style.colorScheme");
	});

	it("renders three accessible choices and reports the resolved system theme", () => {
		const markup = renderToStaticMarkup(createElement(IntlProvider, {
			locale: "zh-CN",
			messages: zhCNMessages,
		}, createElement(ThemePreferenceControl, {
				preference: "system",
				resolvedTheme: "dark",
				onChange: () => undefined,
			}),
		));
		expect(markup.match(/type="radio"/g)).toHaveLength(3);
		expect(markup).toContain("value=\"light\"");
		expect(markup).toContain("value=\"dark\"");
		expect(markup).toMatch(/checked="" value="system"|value="system" checked=""/);
		expect(markup).toContain("当前使用暗部");
	});
});
