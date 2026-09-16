import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE_KEY, resolveLocale, type SupportedLocale } from "@/features/i18n/model/locale";

export async function requestLocale(): Promise<SupportedLocale> {
	const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
	return resolveLocale(cookieStore.get(LOCALE_COOKIE_KEY)?.value, headerStore.get("accept-language"));
}
