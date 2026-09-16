"use client";

import { ChevronRight, Folder, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { localFilesApi } from "@/features/chat/api/local-files-api";

interface LocalDirectoryPickerProps {
	initialPath?: string;
	onClose(): void;
	onSelect(path: string): void;
}

export function LocalDirectoryPicker({ initialPath, onClose, onSelect }: LocalDirectoryPickerProps) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [requestedPath, setRequestedPath] = useState<string | undefined>(initialPath || undefined);
	const [rootPath, setRootPath] = useState("/");
	const [currentPath, setCurrentPath] = useState(initialPath || "");
	const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([]);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<unknown>(null);

	useEffect(() => {
		const controller = new AbortController();
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted) return;
			setLoading(true);
			setLoadError(null);
			try {
				const listing = await localFilesApi.listSystem(requestedPath, controller.signal);
				setRootPath(listing.rootPath);
				setCurrentPath(listing.currentPath);
				setDirectories(
					listing.entries
						.filter((entry) => entry.type === "directory")
						.map((entry) => ({ name: entry.name, path: entry.path })),
				);
			} catch (requestError) {
				if (!controller.signal.aborted) setLoadError(requestError);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		});
		return () => controller.abort();
	}, [requestedPath]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const visibleDirectories = useMemo(() => {
		const normalizedQuery = query.trim().toLocaleLowerCase();
		return normalizedQuery
			? directories.filter((directory) => directory.name.toLocaleLowerCase().includes(normalizedQuery))
			: directories;
	}, [directories, query]);
	const breadcrumbs = directoryBreadcrumbs(currentPath, rootPath);

	const navigate = (path: string | undefined) => {
		setQuery("");
		setRequestedPath(path);
	};

	return (
		<div className="fixed inset-0 z-[90] grid place-items-center bg-zinc-950/35 p-5" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: "session.workDir.chooseLabel" })}>
			<div className="flex h-[min(620px,calc(100dvh-40px))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
				<header className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
					<div><h2 className="text-sm font-semibold text-zinc-800">{intl.formatMessage({ id: "session.workDir.chooseLabel" })}</h2><p className="mt-1 text-[10px] text-zinc-400">{intl.formatMessage({ id: "session.workDir.description" })}</p></div>
					<button type="button" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" aria-label={intl.formatMessage({ id: "session.workDir.picker.close" })} onClick={onClose}><X size={15} /></button>
				</header>

				<div className="border-b border-zinc-100 bg-zinc-50/70 px-5 py-3">
					<div className="flex min-h-7 flex-wrap items-center gap-1 font-mono text-[10px] text-zinc-500">
						{breadcrumbs.map((breadcrumb, index) => (
							<span key={breadcrumb.path} className="flex items-center gap-1">
								{index > 0 ? <ChevronRight size={11} className="text-zinc-300" /> : null}
								<button type="button" className={index === breadcrumbs.length - 1 ? "font-semibold text-zinc-800" : "hover:text-[#397b5c]"} disabled={loading || index === breadcrumbs.length - 1} onClick={() => navigate(breadcrumb.path)}>{breadcrumb.label}</button>
							</span>
						))}
					</div>
					<div className="relative mt-3">
						<Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
						<input type="search" aria-label={intl.formatMessage({ id: "session.workDir.filter" })} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={intl.formatMessage({ id: "session.workDir.filter" })} className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 text-[10px] outline-none focus:border-[#7aa48e] focus:ring-2 focus:ring-[#397b5c]/10" />
					</div>
				</div>

				<div className="app-scrollbar relative min-h-0 flex-1 overflow-y-auto p-3" aria-busy={loading}>
					{loadError ? (
						<div className="grid h-full place-items-center px-6 text-center"><div><p className="text-[11px] text-rose-600">{localizedErrorMessage(loadError)}</p><button type="button" className="mt-3 rounded-lg border border-zinc-200 px-3 py-2 text-[10px] font-semibold text-zinc-600 hover:bg-zinc-50" onClick={() => navigate(undefined)}>{intl.formatMessage({ id: "session.workDir.root" })}</button></div></div>
					) : null}
					{!loadError && !loading && visibleDirectories.length === 0 ? <div className="grid h-full place-items-center text-[10px] text-zinc-400">{intl.formatMessage({ id: "session.workDir.empty" })}</div> : null}
					{!loadError ? visibleDirectories.map((directory) => (
						<button key={directory.path} type="button" className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-[#f1f6f3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397b5c]/25" disabled={loading} onClick={() => navigate(directory.path)}>
							<span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-500"><Folder size={15} /></span>
							<span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-medium text-zinc-700">{directory.name}</span><span className="mt-0.5 block truncate font-mono text-[9px] text-zinc-400">{directory.path}</span></span>
							<ChevronRight size={13} className="shrink-0 text-zinc-300" />
						</button>
					)) : null}
					{loading ? <div className="absolute inset-0 grid place-items-center bg-white/70"><span className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-2 text-[10px] text-zinc-500 shadow-sm"><LoaderCircle size={13} className="animate-spin" /> {intl.formatMessage({ id: "session.workDir.reading" })}</span></div> : null}
				</div>

				<footer className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-4">
					<p className="min-w-0 truncate font-mono text-[10px] text-zinc-500" title={currentPath}>{currentPath || intl.formatMessage({ id: "session.workDir.resolving" })}</p>
					<div className="flex shrink-0 gap-2"><button type="button" className="rounded-lg border px-4 py-2 text-[10px]" onClick={onClose}>{intl.formatMessage({ id: "common.cancel" })}</button><button type="button" disabled={loading || loadError !== null || !currentPath} className="rounded-lg bg-[#397b5c] px-4 py-2 text-[10px] font-semibold text-white disabled:opacity-40" onClick={() => onSelect(currentPath)}>{intl.formatMessage({ id: "session.workDir.chooseCurrent" })}</button></div>
				</footer>
			</div>
		</div>
	);
}

export function directoryBreadcrumbs(path: string, rootPath: string): Array<{ label: string; path: string }> {
	if (!path) return [];
	const breadcrumbs = [{ label: rootPath, path: rootPath }];
	if (path === rootPath) return breadcrumbs;
	const relative = path.slice(rootPath === "/" ? 1 : rootPath.length).split("/").filter(Boolean);
	let current = rootPath;
	for (const part of relative) {
		current = current === "/" ? `/${part}` : `${current}/${part}`;
		breadcrumbs.push({ label: part, path: current });
	}
	return breadcrumbs;
}
