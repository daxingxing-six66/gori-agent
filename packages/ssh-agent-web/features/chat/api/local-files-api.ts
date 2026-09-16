import { apiRequest } from "@/shared/api/client";

export interface LocalFileEntry {
	name: string;
	path: string;
	relativePath: string;
	type: "file" | "directory";
	size: number;
	modifiedAt: number;
}

export interface LocalDirectoryListing {
	rootPath: string;
	currentPath: string;
	relativePath: string;
	entries: LocalFileEntry[];
}

export interface LocalFileSearchResult {
	entries: LocalFileEntry[];
	truncated: boolean;
}

interface LocalFileSearchOptions {
	signal?: AbortSignal;
	maxDirectories?: number;
	maxResults?: number;
	concurrency?: number;
}

const skippedSearchDirectoryNames = new Set([
	".cache",
	".git",
	".local",
	".next",
	".turbo",
	"build",
	"coverage",
	"dist",
	"node_modules",
]);

export const localFilesApi = {
	listSession: (sessionId: string, path?: string, signal?: AbortSignal) =>
		apiRequest<LocalDirectoryListing>(
			`/api/sessions/${encodeURIComponent(sessionId)}/local-files${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
			{ signal },
		),
	listSystem: (path?: string, signal?: AbortSignal) =>
		apiRequest<LocalDirectoryListing>(
			`/api/local-files${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
			{ signal },
		),
	searchSession: async (
		sessionId: string,
		query: string,
		options: LocalFileSearchOptions = {},
	): Promise<LocalFileSearchResult> => {
		const normalizedQuery = query.trim().toLocaleLowerCase();
		if (!normalizedQuery) return { entries: [], truncated: false };
		const maxDirectories = options.maxDirectories ?? 800;
		const maxResults = options.maxResults ?? 80;
		const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
		const root = await localFilesApi.listSession(sessionId, undefined, options.signal);
		const matches: LocalFileEntry[] = [];
		const directoryQueue: string[] = [];
		let nextDirectoryIndex = 0;
		let scannedDirectories = 1;

		collectEntries(root.entries, normalizedQuery, matches, directoryQueue, maxResults);

		const worker = async () => {
			while (matches.length < maxResults && scannedDirectories < maxDirectories) {
				if (options.signal?.aborted) throw options.signal.reason;
				const directoryPath = directoryQueue[nextDirectoryIndex];
				if (directoryPath === undefined) return;
				nextDirectoryIndex += 1;
				scannedDirectories += 1;
				try {
					const listing = await localFilesApi.listSession(sessionId, directoryPath, options.signal);
					collectEntries(listing.entries, normalizedQuery, matches, directoryQueue, maxResults);
				} catch (requestError) {
					if (options.signal?.aborted) throw requestError;
					// A single unreadable or concurrently removed directory must not fail the whole search.
				}
			}
		};

		await Promise.all(Array.from({ length: concurrency }, () => worker()));
		matches.sort((left, right) => compareSearchEntries(left, right, normalizedQuery));
		return {
			entries: matches.slice(0, maxResults),
			truncated: matches.length >= maxResults || nextDirectoryIndex < directoryQueue.length,
		};
	},
};

function collectEntries(
	entries: LocalFileEntry[],
	query: string,
	matches: LocalFileEntry[],
	directoryQueue: string[],
	maxResults: number,
): void {
	for (const entry of entries) {
		if (entry.type === "directory" && !skippedSearchDirectoryNames.has(entry.name)) directoryQueue.push(entry.path);
		if (matches.length >= maxResults) continue;
		if (entry.name.toLocaleLowerCase().includes(query) || entry.relativePath.toLocaleLowerCase().includes(query)) {
			matches.push(entry);
		}
	}
}

function compareSearchEntries(left: LocalFileEntry, right: LocalFileEntry, query: string): number {
	const leftName = left.name.toLocaleLowerCase();
	const rightName = right.name.toLocaleLowerCase();
	const leftRank = leftName === query ? 0 : leftName.startsWith(query) ? 1 : leftName.includes(query) ? 2 : 3;
	const rightRank = rightName === query ? 0 : rightName.startsWith(query) ? 1 : rightName.includes(query) ? 2 : 3;
	return leftRank - rightRank || left.relativePath.localeCompare(right.relativePath);
}
