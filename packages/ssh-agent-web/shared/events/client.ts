import type { SupportedLocale } from "@/features/i18n/model/locale";

// Always use the events origin, including production. A relative fallback would share REST's connection budget.
const configuredBaseUrl =
	process.env.NEXT_PUBLIC_SSH_AGENT_EVENTS_BASE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:3002";

export function eventUrl(path: string): string {
	return `${configuredBaseUrl}${path}`;
}

export function eventUrlWithLocale(path: string, locale: SupportedLocale): string {
	const url = new URL(path, "http://ssh-agent.local");
	url.searchParams.set("locale", locale);
	return eventUrl(`${url.pathname}${url.search}`);
}
