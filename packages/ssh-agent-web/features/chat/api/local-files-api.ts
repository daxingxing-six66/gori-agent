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
	incomplete: boolean;
}

interface LocalFileSearchOptions {
	signal?: AbortSignal;
	includeIgnored?: boolean;
	refresh?: boolean;
}

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
		if (!query.trim()) return { entries: [], truncated: false, incomplete: false };
		const parameters = new URLSearchParams({ query });
		if (options.includeIgnored) parameters.set("includeIgnored", "true");
		if (options.refresh) parameters.set("refresh", "true");
		return apiRequest<LocalFileSearchResult>(`/api/sessions/${encodeURIComponent(sessionId)}/local-files/search?${parameters}`, { signal: options.signal });
	},
};
