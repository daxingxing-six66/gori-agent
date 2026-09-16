import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache, IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { LanguageSelector } from "../features/i18n/components/language-selector.tsx";
import { LocaleContext } from "../features/i18n/components/locale-context.ts";
import { enUSMessages } from "../features/i18n/messages/en-US.ts";
import { zhCNMessages } from "../features/i18n/messages/zh-CN.ts";
import {
	LOCALE_METADATA,
	SUPPORTED_LOCALES,
	localeCookie,
	localeDirection,
	localeFromLanguageTag,
	parseSupportedLocale,
	resolveLocale,
} from "../features/i18n/model/locale.ts";

describe("locale state", () => {
	it("prefers a valid cookie over the browser language", () => {
		expect(resolveLocale("en-US", "zh-CN,zh;q=0.9")).toBe("en-US");
		expect(resolveLocale("invalid", "zh-Hans-CN,zh;q=0.9")).toBe("zh-CN");
	});

	it("normalizes Chinese language tags and defaults other languages to English", () => {
		expect(localeFromLanguageTag("zh-Hans-CN, en;q=0.8")).toBe("zh-CN");
		expect(localeFromLanguageTag("en-GB,en;q=0.9")).toBe("en-US");
		expect(localeFromLanguageTag("fr-FR,zh;q=0.4")).toBe("en-US");
		expect(localeFromLanguageTag(undefined)).toBe("zh-CN");
		expect(parseSupportedLocale("zh-CN")).toBe("zh-CN");
		expect(parseSupportedLocale("zh-TW")).toBeNull();
	});

	it("builds the persistent locale cookie contract", () => {
		expect(localeCookie("en-US", false)).toBe("ssh-agent-locale=en-US; Path=/; Max-Age=31536000; SameSite=Lax");
		expect(localeCookie("zh-CN", true)).toContain("; Secure");
	});

	it("keeps selector metadata complete for every supported locale", () => {
		expect(Object.keys(LOCALE_METADATA).sort()).toEqual([...SUPPORTED_LOCALES].sort());
		for (const locale of SUPPORTED_LOCALES) {
			expect(LOCALE_METADATA[locale].nativeName.length).toBeGreaterThan(0);
			expect(localeDirection(locale)).toBe(LOCALE_METADATA[locale].direction);
		}
	});

	it("keeps both catalogs complete and all ICU messages parseable", () => {
		expect(Object.keys(enUSMessages).sort()).toEqual(Object.keys(zhCNMessages).sort());
		expect(zhCNMessages["provider.title"]).toBe("模型提供商");
		expect(enUSMessages["provider.title"]).toBe("LLM Provider");
		for (const [locale, messages] of [["zh-CN", zhCNMessages], ["en-US", enUSMessages]] as const) {
			const errors: Error[] = [];
			const intl = createIntl({ locale, messages, onError: (error) => errors.push(error) }, createIntlCache());
			for (const id of Object.keys(messages) as Array<keyof typeof messages>) {
				const message = messages[id];
				const values = Object.fromEntries(Array.from(message.matchAll(/\{\s*([A-Za-z][A-Za-z0-9_]*)/g), (match) => [match[1], 2]));
				intl.formatMessage({ id }, values);
			}
			expect(errors).toEqual([]);
		}
	});

	it("renders two accessible language choices with native names", () => {
		const markup = renderToStaticMarkup(createElement(IntlProvider, {
			locale: "en-US",
			messages: enUSMessages,
		}, createElement(LocaleContext.Provider, {
				value: { locale: "en-US", setLocale: () => undefined },
			}, createElement(LanguageSelector)),
		));
		expect(markup.match(/type="radio"/g)).toHaveLength(2);
		expect(markup).toContain("简体中文");
		expect(markup).toContain("English");
		expect(markup).toMatch(/checked="" value="en-US"|value="en-US" checked=""/);
	});
});
