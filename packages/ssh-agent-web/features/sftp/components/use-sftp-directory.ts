"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { sftpApi } from "@/features/sftp/api/sftp-api";
import { initialSftpDirectory, isAbsoluteRemotePath } from "@/features/sftp/model/sftp-state";
import type { SftpDirectoryEntry } from "@/features/sftp/model/sftp";

export type SftpEntryTypeFilter = "all" | SftpDirectoryEntry["type"];

export function useSftpDirectory(workspaceId: string, defaultCwd: string, completedTransferVersion: number) {
	const localizedErrorMessage = useLocalizedErrorMessage();
	const initialDirectory = initialSftpDirectory(defaultCwd);
	const [path, setPath] = useState(initialDirectory.path);
	const [rootFallbackAccepted, setRootFallbackAccepted] = useState(!initialDirectory.requiresRootFallback);
	const [entries, setEntries] = useState<SftpDirectoryEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [entryTypeFilter, setEntryTypeFilter] = useState<SftpEntryTypeFilter>("all");
	const requestIdRef = useRef(0);
	const pathRef = useRef(path);

	useEffect(() => {
		pathRef.current = path;
	}, [path]);

	const loadDirectory = useCallback(async (nextPath: string) => {
		const requestId = ++requestIdRef.current;
		setLoading(true);
		try {
			const result = await sftpApi.listDirectory(workspaceId, nextPath);
			if (requestId !== requestIdRef.current) return;
			pathRef.current = result.path;
			setPath(result.path);
			setEntries(result.entries);
			setRequestError(null);
		} catch (requestError) {
			if (requestId !== requestIdRef.current) return;
			setRequestError(requestError);
		} finally {
			if (requestId === requestIdRef.current) setLoading(false);
		}
	}, [workspaceId]);

	const navigate = useCallback((nextPath: string) => {
		setSearchQuery("");
		void loadDirectory(nextPath);
	}, [loadDirectory]);

	const acceptRootFallback = useCallback(() => {
		setRootFallbackAccepted(true);
		navigate("/");
	}, [navigate]);

	const reload = useCallback(() => loadDirectory(pathRef.current), [loadDirectory]);

	useEffect(() => {
		if (!isAbsoluteRemotePath(defaultCwd)) return;
		queueMicrotask(() => void loadDirectory(defaultCwd));
	}, [defaultCwd, loadDirectory]);

	useEffect(() => {
		if (completedTransferVersion > 0 && rootFallbackAccepted) queueMicrotask(() => void reload());
	}, [completedTransferVersion, reload, rootFallbackAccepted]);

	const visibleEntries = useMemo(() => {
		const query = searchQuery.trim().toLocaleLowerCase();
		return entries.filter((entry) =>
			(entryTypeFilter === "all" || entry.type === entryTypeFilter)
			&& (query.length === 0 || entry.name.toLocaleLowerCase().includes(query))
		);
	}, [entries, entryTypeFilter, searchQuery]);

	return {
		path,
		entries,
		visibleEntries,
		loading,
		error: requestError === null ? null : localizedErrorMessage(requestError),
		rootFallbackAccepted,
		requiresRootFallback: !isAbsoluteRemotePath(defaultCwd) && !rootFallbackAccepted,
		searchQuery,
		setSearchQuery,
		entryTypeFilter,
		setEntryTypeFilter,
		filtering: searchQuery.trim().length > 0 || entryTypeFilter !== "all",
		navigate,
		reload,
		acceptRootFallback,
	};
}
