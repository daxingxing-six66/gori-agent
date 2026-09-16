export function sessionNameFromMessage(message: string, fallbackName = "New conversation", maximumLength = 6): string {
	const normalized = message.trim().replace(/\s+/gu, " ");
	if (!normalized) return fallbackName;
	return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized), ({ segment }) => segment)
		.slice(0, maximumLength)
		.join("");
}
