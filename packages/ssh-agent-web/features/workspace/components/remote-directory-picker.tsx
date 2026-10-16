"use client";

import { ChevronRight, Folder, LoaderCircle, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import type { SftpDirectoryEntry } from "@/features/sftp/model/sftp";
import { directoryBreadcrumbs } from "@/features/session/components/local-directory-picker";
import { isRemoteDirectory, isRemoteSandboxRoot, MAX_SANDBOX_WRITABLE_ROOTS } from "../model/sandbox-writable-roots";
import "./sandbox-writable-roots.css";

interface DirectoryBrowserProps {
	initialPath: string;
	load(path: string, signal: AbortSignal): Promise<{ path: string; entries: SftpDirectoryEntry[] }>;
	onClose(): void;
}

type RemoteDirectoryPickerProps = DirectoryBrowserProps & (
	| { multiple?: undefined; onSelect(path: string): void }
	| { multiple: { initialPaths: readonly string[]; onSelect(paths: string[]): void }; onSelect?: never }
);

export function RemoteDirectoryPicker({ initialPath, load, onClose, onSelect, multiple }: RemoteDirectoryPickerProps) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [requestedPath, setRequestedPath] = useState(initialPath);
	const [currentPath, setCurrentPath] = useState("");
	const [loadedRequestedPath, setLoadedRequestedPath] = useState<string | null>(null);
	const [entries, setEntries] = useState<SftpDirectoryEntry[]>([]);
	const [selectedPaths, setSelectedPaths] = useState(() => [...(multiple?.initialPaths ?? [])]);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [reloadVersion, setReloadVersion] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted) return;
			setLoading(true);
			setLoadError(null);
			try {
				const listing = await load(requestedPath, controller.signal);
				if (controller.signal.aborted) return;
				setCurrentPath(listing.path);
				setLoadedRequestedPath(requestedPath);
				setEntries(listing.entries);
			} catch (error) {
				if (!controller.signal.aborted) setLoadError(error);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		});
		return () => controller.abort();
	}, [load, requestedPath, reloadVersion]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const visible = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		return entries.filter((entry) => entry.type === "directory" && (!normalized || entry.name.toLocaleLowerCase().includes(normalized)));
	}, [entries, query]);
	const breadcrumbs = directoryBreadcrumbs(currentPath, "/");
	const navigate = (path: string) => {
		setQuery("");
		setLoading(true);
		setLoadedRequestedPath(null);
		setRequestedPath(path);
		if (path === requestedPath) setReloadVersion((version) => version + 1);
	};
	const togglePath = (path: string) => setSelectedPaths((current) => current.includes(path)
		? current.filter((entry) => entry !== path)
		: current.length < MAX_SANDBOX_WRITABLE_ROOTS && isRemoteSandboxRoot(path) ? [...current, path] : current);
	const canChooseCurrent = !loading && loadError === null && (multiple ? isRemoteSandboxRoot(currentPath) : isRemoteDirectory(currentPath)) && loadedRequestedPath === requestedPath;
	const title = intl.formatMessage({ id: multiple ? "sandbox.roots.choose" : "workspace.directory.remoteChoose" });

	return (
		<div className="fixed inset-0 z-[90] grid place-items-center bg-zinc-950/35 p-5" role="dialog" aria-modal="true" aria-label={title}>
			<div className="flex h-[min(620px,calc(100dvh-40px))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface-raised text-primary shadow-2xl">
				<header className="flex items-center justify-between border-b border-[var(--line-soft)] px-5 py-4">
					<div>
						<h2 className="text-sm font-semibold">{title}</h2>
						<p className="mt-1 text-[11px] text-secondary">{intl.formatMessage({ id: multiple ? "sandbox.roots.pickerHint" : "workspace.directory.remoteHint" })}</p>
					</div>
					<button type="button" className="rounded-lg p-2 text-secondary hover:bg-surface-hover" aria-label={intl.formatMessage({ id: "session.workDir.picker.close" })} onClick={onClose}><X size={15} aria-hidden="true" /></button>
				</header>
				<div className="border-b border-[var(--line-soft)] bg-surface-muted px-5 py-3">
					<div className="flex min-h-7 flex-wrap items-center gap-1 font-mono text-[11px] text-secondary">
						{breadcrumbs.map((crumb, index) => <span key={crumb.path} className="flex items-center gap-1">
							{index > 0 ? <ChevronRight size={11} aria-hidden="true" /> : null}
							<button type="button" disabled={loading || index === breadcrumbs.length - 1} className={index === breadcrumbs.length - 1 ? "font-semibold text-primary" : "hover:text-accent"} onClick={() => navigate(crumb.path)}>{crumb.label}</button>
						</span>)}
					</div>
					<div className="relative mt-2">
						<Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-secondary" aria-hidden="true" />
						<input type="search" aria-label={intl.formatMessage({ id: "session.workDir.filter" })} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={intl.formatMessage({ id: "session.workDir.filter" })} className="h-9 w-full rounded-lg border border-[var(--line)] bg-surface-raised pl-9 pr-3 text-[11px] outline-none focus:border-[var(--accent)]" />
					</div>
				</div>
				<div className="app-scrollbar relative min-h-0 flex-1 overflow-y-auto p-3" aria-busy={loading}>
					{loadError ? <div className="grid h-full place-items-center px-6 text-center"><div>
						<p role="alert" className="text-[11px] text-danger">{localizedErrorMessage(loadError)}</p>
						<button type="button" className="mt-3 rounded-lg border border-[var(--line)] px-3 py-2 text-[11px] text-secondary" onClick={() => navigate("/")}>{intl.formatMessage({ id: "session.workDir.root" })}</button>
					</div></div> : null}
					{!loadError && !loading && visible.length === 0 ? <div className="grid h-full place-items-center text-[11px] text-secondary">{intl.formatMessage({ id: "session.workDir.empty" })}</div> : null}
					{!loadError ? visible.map((entry) => <div key={entry.path} className="flex items-center gap-1 rounded-lg hover:bg-surface-hover">
						{multiple ? <input type="checkbox" className="ml-3 h-3.5 w-3.5 accent-[var(--accent)]" checked={selectedPaths.includes(entry.path)}
							disabled={loading || !isRemoteSandboxRoot(entry.path) || (!selectedPaths.includes(entry.path) && selectedPaths.length >= MAX_SANDBOX_WRITABLE_ROOTS)}
							aria-label={intl.formatMessage({ id: "sandbox.roots.select" }, { path: entry.path })} onChange={() => togglePath(entry.path)} /> : null}
						<button type="button" disabled={loading} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => navigate(entry.path)}>
							<Folder size={14} className="shrink-0 text-secondary" aria-hidden="true" />
							<span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium">{entry.name}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-secondary" title={entry.path}>{entry.path}</span></span>
							<ChevronRight size={13} className="shrink-0 text-secondary" aria-hidden="true" />
						</button>
					</div>) : null}
					{loading ? <div className="absolute inset-0 grid place-items-center bg-surface-raised/80"><span className="flex items-center gap-2 text-[11px] text-secondary"><LoaderCircle size={13} className="animate-spin" aria-hidden="true" />{intl.formatMessage({ id: "session.workDir.reading" })}</span></div> : null}
				</div>
				<footer className="border-t border-[var(--line-soft)] px-5 py-4">
					{multiple ? <div className="sandbox-picker-selection" aria-label={intl.formatMessage({ id: "sandbox.roots.selected" }, { count: selectedPaths.length })}>
						{selectedPaths.map((path) => <button key={path} type="button" title={path} aria-label={intl.formatMessage({ id: "sandbox.roots.remove" }, { path })} onClick={() => togglePath(path)}><span>{path}</span><X size={11} className="shrink-0" aria-hidden="true" /></button>)}
					</div> : null}
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary" title={currentPath}>{currentPath || intl.formatMessage({ id: "session.workDir.resolving" })}</p>
						{multiple ? <button type="button" className="flex items-center gap-1 text-[11px] text-accent disabled:opacity-40" disabled={!canChooseCurrent || selectedPaths.includes(currentPath) || selectedPaths.length >= MAX_SANDBOX_WRITABLE_ROOTS} onClick={() => togglePath(currentPath)}><Plus size={12} aria-hidden="true" />{intl.formatMessage({ id: "sandbox.roots.addCurrent" })}</button> : null}
						<div className="flex shrink-0 gap-2">
							<button type="button" className="rounded-lg border border-[var(--line)] px-3 py-2 text-[11px]" onClick={onClose}>{intl.formatMessage({ id: "common.cancel" })}</button>
							<button type="button" disabled={multiple ? selectedPaths.length === 0 : !canChooseCurrent} className="rounded-lg bg-accent px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-40" onClick={() => { if (multiple) multiple.onSelect(selectedPaths); else onSelect(currentPath); }}>
								{intl.formatMessage({ id: multiple ? "sandbox.roots.confirm" : "session.workDir.chooseCurrent" }, { count: selectedPaths.length })}
							</button>
						</div>
					</div>
				</footer>
			</div>
		</div>
	);
}
