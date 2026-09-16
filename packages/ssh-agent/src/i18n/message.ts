import { type BackendMessageKey, enUSMessages } from "./catalogs/en-US.ts";
import { zhCNMessages } from "./catalogs/zh-CN.ts";

export const BACKEND_LOCALES = ["zh-CN", "en-US"] as const;
export type BackendLocale = (typeof BACKEND_LOCALES)[number];
export type BackendMessageValue = string | number | boolean;
export type BackendMessageValues = Readonly<Record<string, BackendMessageValue>>;

export interface BackendMessageDescriptor {
	readonly key: BackendMessageKey;
	readonly values?: BackendMessageValues;
}

export function backendMessage(key: BackendMessageKey, values?: BackendMessageValues): BackendMessageDescriptor {
	return { key, ...(values === undefined ? {} : { values }) };
}

export function formatBackendMessage(locale: BackendLocale, descriptor: BackendMessageDescriptor): string {
	const catalog = locale === "zh-CN" ? zhCNMessages : enUSMessages;
	const template = catalog[descriptor.key] ?? enUSMessages[descriptor.key];
	const validation = validateBackendMessageDescriptor(descriptor);
	if (!validation.valid) {
		throw new Error(`Invalid backend message values for ${descriptor.key}: ${validation.errors.join(", ")}`);
	}
	return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name: string) => {
		const value = descriptor.values?.[name];
		return value === undefined ? placeholder : String(value);
	});
}

export function validateBackendMessageDescriptor(descriptor: BackendMessageDescriptor): {
	readonly valid: boolean;
	readonly errors: readonly string[];
} {
	const expected = placeholders(enUSMessages[descriptor.key]);
	const actual = new Set(Object.keys(descriptor.values ?? {}));
	const errors = [
		...[...expected].filter((name) => !actual.has(name)).map((name) => `missing ${name}`),
		...[...actual].filter((name) => !expected.has(name)).map((name) => `unexpected ${name}`),
	];
	return { valid: errors.length === 0, errors };
}

export function validateBackendMessageCatalogs(): readonly string[] {
	const errors: string[] = [];
	const englishKeys = new Set(Object.keys(enUSMessages));
	const chineseKeys = new Set(Object.keys(zhCNMessages));
	for (const key of englishKeys) if (!chineseKeys.has(key)) errors.push(`${key} missing from zh-CN`);
	for (const key of chineseKeys) if (!englishKeys.has(key)) errors.push(`${key} missing from en-US`);
	for (const key of Object.keys(enUSMessages) as BackendMessageKey[]) {
		const english = placeholders(enUSMessages[key]);
		const chinese = placeholders(zhCNMessages[key]);
		if ([...english].some((name) => !chinese.has(name)) || [...chinese].some((name) => !english.has(name))) {
			errors.push(`${key} placeholder mismatch`);
		}
	}
	return errors;
}

export function parseBackendMessageDescriptor(value: unknown): BackendMessageDescriptor | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.key !== "string" || !(record.key in enUSMessages)) return undefined;
	if (record.values === undefined) return { key: record.key as BackendMessageKey };
	if (record.values === null || typeof record.values !== "object" || Array.isArray(record.values)) return undefined;
	const values: Record<string, BackendMessageValue> = {};
	for (const [key, entry] of Object.entries(record.values as Record<string, unknown>)) {
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") return undefined;
		values[key] = entry;
	}
	return { key: record.key as BackendMessageKey, values };
}

export function resolveBackendLocale(input: {
	readonly locale?: string | null;
	readonly acceptLanguage?: string | null;
}): BackendLocale {
	if (input.locale?.trim()) return normalizeLocale(input.locale) ?? "en-US";
	const accepted = preferredLanguage(input.acceptLanguage);
	return accepted === undefined ? "zh-CN" : (normalizeLocale(accepted) ?? "en-US");
}

function normalizeLocale(value: string | null | undefined): BackendLocale | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (
		normalized === "zh" ||
		normalized === "zh-cn" ||
		normalized.startsWith("zh-cn-") ||
		normalized === "zh-hans" ||
		normalized.startsWith("zh-hans-")
	)
		return "zh-CN";
	if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
	return undefined;
}

function preferredLanguage(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((entry, index) => {
			const [tag = "", ...parameters] = entry.trim().split(";");
			const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
			const parsed = quality === undefined ? 1 : Number.parseFloat(quality.trim().slice(2));
			return { tag: tag.trim(), quality: Number.isFinite(parsed) ? parsed : 0, index };
		})
		.filter((entry) => entry.tag.length > 0 && entry.tag !== "*" && entry.quality > 0)
		.sort((left, right) => right.quality - left.quality || left.index - right.index)[0]?.tag;
}

function placeholders(template: string): ReadonlySet<string> {
	return new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1] as string));
}

export type { BackendMessageKey } from "./catalogs/en-US.ts";
