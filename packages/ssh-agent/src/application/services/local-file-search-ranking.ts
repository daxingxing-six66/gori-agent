/** Prepared once per indexed path, rather than normalizing every keypress. */
export interface SearchCandidate {
	relativePath: string;
	type: "file" | "directory";
	name: string;
	lowerName: string;
	lowerPath: string;
	stem: string;
	initials: string;
	compactName: string;
	wordStarts: number[];
}

export function normalizeFileQuery(value: string): string {
	return value.normalize("NFKC").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

export function prepareSearchCandidate(relativePath: string, type: SearchCandidate["type"]): SearchCandidate {
	const name = relativePath.split("/").at(-1)!;
	const normalizedName = name.normalize("NFKC");
	const words = normalizedName.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const lowerName = normalizedName.toLowerCase();
	const wordStarts: number[] = [];
	for (let index = 0; index < normalizedName.length; index++) {
		const previous = normalizedName[index - 1] ?? "";
		const current = normalizedName[index]!;
		if (index === 0 || /[^\p{L}\p{N}]/u.test(previous) ||
			(/[A-Z]/.test(current) && (/[a-z0-9]/.test(previous) || /[a-z]/.test(normalizedName[index + 1] ?? "")))) wordStarts.push(index);
	}
	return {
		relativePath, type, name, lowerName, lowerPath: normalizeFileQuery(relativePath),
		stem: type === "file" ? lowerName.replace(/\.[^.]+$/, "") : lowerName,
		initials: words.map((word) => word[0]).join("").toLowerCase(),
		compactName: lowerName.replace(/[^\p{L}\p{N}]/gu, ""),
		wordStarts,
	};
}

/** Lower is better. Filename tiers always beat incidental matches in a parent path. */
export function fileSearchScore(candidate: SearchCandidate, query: string): number | undefined {
	const { lowerName: name, lowerPath: path } = candidate;
	if (!query) return 0;
	if (query.includes("/")) {
		if (path === query) return 0;
		if (path.endsWith(`/${query}`)) return 1000;
		const position = path.indexOf(query);
		if (position >= 0) return 2000 + position;
		const gap = subsequenceCost(path, query);
		return gap === undefined ? undefined : 8000 + gap;
	}
	if (name === query) return 0;
	if (candidate.stem === query) return 1000;
	if (name.startsWith(query)) return 2000;
	const position = name.indexOf(query);
	if (position >= 0) return 3000 + position;
	if (candidate.initials.startsWith(query)) return 4000;
	const compactQuery = query.replace(/[^\p{L}\p{N}]/gu, "");
	if (compactQuery && candidate.compactName.includes(compactQuery)) return 5000;
	// Short queries use literal matching to avoid flooding the menu with weak matches.
	if (query.length >= 3) {
		const text = query.includes(".") ? name : candidate.stem;
		const gap = subsequenceCost(text, query, candidate.wordStarts);
		if (gap !== undefined) return 6000 + gap;
	}
	const pathPosition = path.indexOf(query);
	if (pathPosition >= 0) return 7000 + Math.min(pathPosition, 999);
	return undefined;
}

/** Boundary-aware subsequence matching with a compact-span penalty; no edit-distance matrix. */
function subsequenceCost(text: string, query: string, wordStarts?: number[]): number | undefined {
	if (wordStarts) {
		let best: number | undefined;
		for (const start of wordStarts) {
			if (text[start] !== query[0]) continue;
			let end = start;
			for (let index = 1; index < query.length; index++) {
				end = text.indexOf(query[index]!, end + 1);
				if (end < 0) break;
			}
			if (end >= 0) best = Math.min(best ?? 999, (end - start + 1 - query.length) * 4 + start);
		}
		return best;
	}
	let position = -1;
	for (const character of query) {
		position = text.indexOf(character, position + 1);
		if (position < 0) return undefined;
	}
	const end = position;
	for (let index = query.length - 1; index >= 0; index--) position = text.lastIndexOf(query[index]!, position - (index === query.length - 1 ? 0 : 1));
	return Math.min(999, (end - position + 1 - query.length) * 4 + position);
}
