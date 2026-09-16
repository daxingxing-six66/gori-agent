"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Search, Upload, X } from "lucide-react";
import { useIntl } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import { sftpApi } from "@/features/sftp/api/sftp-api";
import { formatBytes, formatDate, SftpDirectoryEntries } from "@/features/sftp/components/sftp-directory-entries";
import { SftpDeleteDialog } from "@/features/sftp/components/sftp-delete-dialog";
import {
	mergeSftpQueueItems,
	SftpTransferQueue,
	type SftpQueueItem,
} from "@/features/sftp/components/sftp-transfer-queue";
import { useSftpTransferManager } from "@/features/sftp/components/sftp-transfer-provider";
import { useSftpDirectory, type SftpEntryTypeFilter } from "@/features/sftp/components/use-sftp-directory";
import { useWorkspaceEvents } from "@/features/sftp/components/use-workspace-events";
import { isTransferActive } from "@/features/sftp/model/sftp-state";
import type { FileTransfer, SftpDirectoryEntry } from "@/features/sftp/model/sftp";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";

export function SftpFilesTab({ workspaceId, defaultCwd, hostLabel }: {
	workspaceId: string;
	defaultCwd: string;
	hostLabel: string;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const transferManager = useSftpTransferManager();
	const directory = useSftpDirectory(workspaceId, defaultCwd, transferManager.completedVersion);
	const [transfers, setTransfers] = useState<FileTransfer[]>([]);
	const [transferListError, setTransferListError] = useState<string | null>(null);
	const [entryErrors, setEntryErrors] = useState<Record<string, string>>({});
	const [entryBusy, setEntryBusy] = useState<Record<string, boolean>>({});
	const [transferErrors, setTransferErrors] = useState<Record<string, string>>({});
	const [transferBusy, setTransferBusy] = useState<Record<string, boolean>>({});
	const [localUploadError, setLocalUploadError] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<SftpDirectoryEntry | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const syncTransfer = transferManager.syncTransfer;
	const entryTypeOptions = [
		{ value: "all", label: intl.formatMessage({ id: "sftp.filter.all" }) },
		{ value: "directory", label: intl.formatMessage({ id: "sftp.filter.directory" }) },
		{ value: "file", label: intl.formatMessage({ id: "sftp.filter.file" }) },
		{ value: "symlink", label: intl.formatMessage({ id: "sftp.filter.symlink" }) },
	];

	const loadTransfers = useCallback(async () => {
		try {
			const result = await sftpApi.listTransfers(workspaceId);
			setTransfers(result.transfers);
			for (const transfer of result.transfers) syncTransfer(transfer);
			setTransferListError(null);
		} catch (requestError) {
			setTransferListError(localizedErrorMessage(requestError));
		}
	}, [localizedErrorMessage, syncTransfer, workspaceId]);

	useEffect(() => {
		void loadTransfers();
	}, [loadTransfers]);

	useWorkspaceEvents(workspaceId, ["connection", "transfers"], {
		onTransfer: (transfer) => {
			setTransfers((current) => [transfer, ...current.filter((item) => item.id !== transfer.id)].slice(0, 50));
			transferManager.syncTransfer(transfer);
		},
		onReconnect: () => { void loadTransfers(); },
	});

	const upload = async (file: File) => {
		const remotePath = joinRemote(directory.path, file.name);
		setLocalUploadError(null);
		if (transfers.some((transfer) => transfer.remotePath === remotePath && isTransferActive(transfer))) {
			setLocalUploadError(intl.formatMessage({ id: "sftp.upload.duplicate" }));
			return;
		}
		const result = await transferManager.startUpload(file, remotePath);
		if (result.status === "duplicate") {
			setLocalUploadError(intl.formatMessage({ id: "sftp.upload.duplicate" }));
			return;
		}
		if (result.status !== "conflict") return;
		const entry = result.entry;
		const overwrite = window.confirm(intl.formatMessage(
			{ id: "sftp.upload.overwrite" },
			{ name: entry?.name ?? file.name, details: entry ? ` (${formatBytes(entry.size)}, ${formatDate(entry.modifiedAt, intl.locale)})` : "" },
		));
		if (overwrite) await transferManager.confirmOverwrite(result.taskId);
		else transferManager.dismissTask(result.taskId);
	};

	const download = async (entry: SftpDirectoryEntry) => {
		setEntryBusy((current) => ({ ...current, [entry.path]: true }));
		setEntryErrors((current) => omitKey(current, entry.path));
		try {
			const transfer = await sftpApi.createDownload(workspaceId, entry.path);
			setTransfers((current) => [transfer, ...current]);
			startBrowserDownload(workspaceId, transfer, entry.name);
		} catch (requestError) {
			setEntryErrors((current) => ({ ...current, [entry.path]: localizedErrorMessage(requestError) }));
		} finally {
			setEntryBusy((current) => omitKey(current, entry.path));
		}
	};

	const confirmDelete = async () => {
		const entry = deleteTarget;
		if (!entry || entryBusy[entry.path]) return;
		setEntryBusy((current) => ({ ...current, [entry.path]: true }));
		setEntryErrors((current) => omitKey(current, entry.path));
		setDeleteError(null);
		try {
			await sftpApi.deleteFile(workspaceId, entry.path);
			setDeleteTarget(null);
			await directory.reload();
		} catch (requestError) {
			const message = localizedErrorMessage(requestError);
			setDeleteError(message);
			setEntryErrors((current) => ({ ...current, [entry.path]: message }));
		} finally {
			setEntryBusy((current) => omitKey(current, entry.path));
		}
	};

	const cancelServerTransfer = async (transfer: FileTransfer) => {
		if (transferBusy[transfer.id]) return;
		setTransferBusy((current) => ({ ...current, [transfer.id]: true }));
		setTransferErrors((current) => omitKey(current, transfer.id));
		try {
			const cancelled = await sftpApi.cancel(workspaceId, transfer.id);
			setTransfers((current) => [cancelled, ...current.filter((item) => item.id !== cancelled.id)]);
		} catch (requestError) {
			setTransferErrors((current) => ({ ...current, [transfer.id]: localizedErrorMessage(requestError) }));
		} finally {
			setTransferBusy((current) => omitKey(current, transfer.id));
		}
	};

	const retryDownload = async (transfer: FileTransfer) => {
		if (transferBusy[transfer.id]) return;
		setTransferBusy((current) => ({ ...current, [transfer.id]: true }));
		setTransferErrors((current) => omitKey(current, transfer.id));
		try {
			const replacement = await sftpApi.createDownload(workspaceId, transfer.remotePath);
			setTransfers((current) => [replacement, ...current]);
			startBrowserDownload(workspaceId, replacement, replacement.fileName);
		} catch (requestError) {
			setTransferErrors((current) => ({ ...current, [transfer.id]: localizedErrorMessage(requestError) }));
		} finally {
			setTransferBusy((current) => omitKey(current, transfer.id));
		}
	};

	const queueItems = useMemo(
		() => mergeSftpQueueItems(transferManager.tasks, transfers).slice(0, 8),
		[transferManager.tasks, transfers],
	);
	const uploadCreating = transferManager.tasks.some((task) => task.phase === "creating");
	const pathParts = directory.path.split("/").filter(Boolean);

	return (
		<>
			<div className="grid min-h-[500px] gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
				<section className="ui-card relative overflow-hidden">
					<header className="flex flex-col gap-3 border-b border-[var(--line-soft)] px-5 py-4 md:flex-row md:items-center md:justify-between">
						<p className="min-w-0 truncate font-mono text-[9px] text-zinc-400">{hostLabel}:{directory.path}</p>
						<div className="flex flex-wrap items-center gap-2">
							<div className="relative min-w-[180px] flex-1 md:w-[220px] md:flex-none"><Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" /><input type="text" inputMode="search" aria-label={intl.formatMessage({ id: "sftp.search" })} value={directory.searchQuery} onChange={(event) => directory.setSearchQuery(event.target.value)} placeholder={intl.formatMessage({ id: "sftp.search" })} className="h-9 w-full rounded-lg border border-[var(--line)] bg-white pl-9 pr-8 text-[10px] text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:border-[#7aa48e] focus:ring-2 focus:ring-[#397b5c]/10" />{directory.searchQuery ? <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600" aria-label={intl.formatMessage({ id: "sftp.search.clear" })} onClick={() => directory.setSearchQuery("")}><X size={11} /></button> : null}</div>
							<div className="w-[112px]"><CustomSelect compact ariaLabel={intl.formatMessage({ id: "sftp.filter" })} value={directory.entryTypeFilter} options={entryTypeOptions} onChange={(value) => directory.setEntryTypeFilter(value as SftpEntryTypeFilter)} /></div>
							<input ref={fileInputRef} type="file" className="hidden" disabled={!directory.rootFallbackAccepted || directory.loading || uploadCreating} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
							<button className="flex h-9 items-center gap-1.5 rounded-lg bg-[#397b5c] px-3 text-[9px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!directory.rootFallbackAccepted || directory.loading || uploadCreating} onClick={() => fileInputRef.current?.click()}><Upload size={12} /> {intl.formatMessage({ id: uploadCreating ? "sftp.upload.preparing" : "sftp.upload" })}</button>
						</div>
					</header>
					<div className="relative min-h-[420px]" aria-busy={directory.loading}>
						{directory.requiresRootFallback ? <div className="border-b border-amber-200 bg-amber-50 px-5 py-4"><div className="flex items-start gap-3"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" /><div><p className="text-[10px] font-semibold text-amber-800">{intl.formatMessage({ id: "sftp.root.invalid" }, { path: defaultCwd })}</p><p className="mt-1 text-[9px] leading-4 text-amber-700">{intl.formatMessage({ id: "sftp.root.description" })}</p><button className="mt-2 rounded-lg bg-amber-700 px-3 py-1.5 text-[9px] font-semibold text-white" onClick={directory.acceptRootFallback}>{intl.formatMessage({ id: "sftp.root.browse" })}</button></div></div></div> : null}
						{directory.rootFallbackAccepted ? <div className="flex flex-wrap items-center gap-1 border-b border-zinc-100 bg-zinc-50/70 px-5 py-3 font-mono text-[10px] text-zinc-500"><button disabled={directory.loading} onClick={() => directory.navigate("/")}>/</button>{pathParts.map((part, index) => <span key={`${part}-${index}`} className="flex items-center gap-1"><span>/</span><button disabled={directory.loading} className={index === pathParts.length - 1 ? "font-semibold text-zinc-800" : ""} onClick={() => directory.navigate(`/${pathParts.slice(0, index + 1).join("/")}`)}>{part}</button></span>)}</div> : null}
						{directory.error ? <div className="flex items-center justify-between bg-rose-50 px-5 py-2 text-[10px] text-rose-700"><span>{directory.error}</span><button className="font-semibold" onClick={() => void directory.reload()}>{intl.formatMessage({ id: "common.reload" })}</button></div> : null}
						{localUploadError ? <button className="w-full bg-rose-50 px-5 py-2 text-left text-[10px] text-rose-700" onClick={() => setLocalUploadError(null)}>{localUploadError}</button> : null}
						{directory.rootFallbackAccepted ? <SftpDirectoryEntries entries={directory.visibleEntries} busy={entryBusy} errors={entryErrors} emptyMessage={intl.formatMessage({ id: directory.filtering ? "sftp.directory.noMatch" : "sftp.directory.empty" })} onOpen={(entry) => directory.navigate(entry.path)} onDownload={(entry) => void download(entry)} onDelete={(entry) => { setDeleteTarget(entry); setDeleteError(null); }} /> : null}
						{directory.loading ? <div className="absolute inset-0 z-10 bg-white/70 backdrop-blur-[1px]"><div className="sticky top-[calc(38vh-14px)] flex h-7 justify-center"><span className="flex h-7 items-center gap-1.5 rounded-full border border-[var(--line-soft)] bg-white/95 px-3 shadow-sm" role="status" aria-label={intl.formatMessage({ id: "sftp.directory.loading" })}><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#397b5c] [animation-delay:-300ms] motion-reduce:animate-none" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#397b5c] [animation-delay:-150ms] motion-reduce:animate-none" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#397b5c] motion-reduce:animate-none" /></span></div></div> : null}
					</div>
				</section>
				<SftpTransferQueue
					items={queueItems}
					activeUploadCount={transferManager.activeUploadCount}
					listError={transferListError}
					busy={transferBusy}
					errors={transferErrors}
					onReload={() => void loadTransfers()}
					onCancel={(item) => cancelQueueItem(item, transferManager.cancelUpload, cancelServerTransfer)}
					onRetry={(item) => retryQueueItem(item, transferManager.retryUpload, retryDownload)}
					onRefreshDirectory={() => void directory.reload()}
					onDismiss={(item) => { if (item.task) transferManager.dismissTask(item.task.clientId); }}
				/>
			</div>
			{deleteTarget ? <SftpDeleteDialog entry={deleteTarget} deleting={entryBusy[deleteTarget.path] ?? false} error={deleteError ?? undefined} onClose={() => { setDeleteTarget(null); setDeleteError(null); }} onConfirm={confirmDelete} /> : null}
		</>
	);
}

function cancelQueueItem(item: SftpQueueItem, cancelUpload: (taskId: string) => Promise<void>, cancelTransfer: (transfer: FileTransfer) => Promise<void>): void {
	if (item.task) void cancelUpload(item.task.clientId);
	else if (item.transfer) void cancelTransfer(item.transfer);
}

function retryQueueItem(item: SftpQueueItem, retryUpload: (taskId: string) => Promise<void>, retryDownload: (transfer: FileTransfer) => Promise<void>): void {
	if (item.task) void retryUpload(item.task.clientId);
	else if (item.transfer?.direction === "download") void retryDownload(item.transfer);
}

function startBrowserDownload(workspaceId: string, transfer: FileTransfer, fileName: string): void {
	const anchor = document.createElement("a");
	anchor.href = sftpApi.downloadUrl(workspaceId, transfer.id);
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
	const next = { ...record };
	delete next[key];
	return next;
}

function joinRemote(directory: string, name: string): string {
	return directory === "/" ? `/${name}` : `${directory.replace(/\/$/, "")}/${name}`;
}
