import type { Usage } from "../types.ts";

/** Preserve explicit API facts before adapters normalize missing counters to zero. */
export function reportedCacheReadDetails(inputTokens: unknown, cachedTokens: unknown): Usage["cacheReadDetails"] {
	if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
		typeof cachedTokens !== "number" || !Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > inputTokens) {
		return undefined;
	}
	return { inputTokens, cachedTokens };
}
