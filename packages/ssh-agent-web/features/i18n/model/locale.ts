export const LOCALE_COOKIE_KEY = "ssh-agent-locale";
export const LOCALE_COOKIE_MAX_AGE = 31_536_000;

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type TextDirection = "ltr" | "rtl";

export const LOCALE_METADATA: Readonly<Record<SupportedLocale, { nativeName: string; direction: TextDirection }>> = {
	"zh-CN": { nativeName: "简体中文", direction: "ltr" },
	"en-US": { nativeName: "English", direction: "ltr" },
};

export function parseSupportedLocale(value: unknown): SupportedLocale | null {
	return value === "zh-CN" || value === "en-US" ? value : null;
}

export function localeDirection(locale: SupportedLocale): TextDirection {
	return LOCALE_METADATA[locale].direction;
}

export function localeFromLanguageTag(value: string | null | undefined): SupportedLocale {
	if (!value) return "zh-CN";
	const preferred = value
		.split(",")
		.map((entry, index) => {
			const [tag = "", ...parameters] = entry.trim().split(";");
			const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
			const parsedQuality = qualityParameter ? Number.parseFloat(qualityParameter.trim().slice(2)) : 1;
			return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(parsedQuality) ? parsedQuality : 0, index };
		})
		.filter(({ tag, quality }) => tag.length > 0 && tag !== "*" && quality > 0)
		.sort((left, right) => right.quality - left.quality || left.index - right.index)[0]?.tag;
	if (!preferred) return "zh-CN";
	return preferred === "zh" || preferred.startsWith("zh-") ? "zh-CN" : "en-US";
}

export function resolveLocale(storedLocale: unknown, acceptedLanguages: string | null | undefined): SupportedLocale {
	return parseSupportedLocale(storedLocale) ?? localeFromLanguageTag(acceptedLanguages);
}

export function localeCookie(locale: SupportedLocale, secure: boolean): string {
	return `${LOCALE_COOKIE_KEY}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
