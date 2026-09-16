import { Check, FileText, RefreshCw, RotateCcw, X } from "lucide-react";
import { useIntl, type IntlShape } from "react-intl";
import { canRetryTransfer, isTransferActive } from "@/features/sftp/model/sftp-state";
import type { FileTransfer, TransferStatus, UploadTask } from "@/features/sftp/model/sftp";

export interface SftpQueueItem {
	key: string;
	transfer?: FileTransfer;
	task?: UploadTask;
}

interface SftpTransferQueueProps {
	items: SftpQueueItem[];
	activeUploadCount: number;
	listError: string | null;
	busy: Record<string, boolean>;
	errors: Record<string, string>;
	onReload(): void;
	onCancel(item: SftpQueueItem): void;
	onRetry(item: SftpQueueItem): void;
	onRefreshDirectory(): void;
	onDismiss(item: SftpQueueItem): void;
}

export function SftpTransferQueue({ items, activeUploadCount, listError, busy, errors, onReload, onCancel, onRetry, onRefreshDirectory, onDismiss }: SftpTransferQueueProps) {
	const intl = useIntl();
	return (
		<aside className="space-y-4">
			<section className="ui-card p-4">
				<div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold">{intl.formatMessage({ id: "sftp.queue.title" })}</h3><span className="text-[9px] text-zinc-400">{intl.formatMessage({ id: "sftp.queue.active" }, { count: activeUploadCount })}</span></div>
				{listError ? <div className="mt-3 rounded-lg bg-rose-50 p-2 text-[9px] text-rose-700"><p>{listError}</p><button className="mt-1 font-semibold" onClick={onReload}>{intl.formatMessage({ id: "common.reload" })}</button></div> : null}
				<div className="mt-3 space-y-2">
					{items.length === 0 ? <p className="py-5 text-center text-[9px] text-zinc-400">{intl.formatMessage({ id: "sftp.queue.empty" })}</p> : items.map((item) => (
						<SftpTransferQueueCard key={item.key} item={item} busy={item.transfer ? busy[item.transfer.id] ?? false : false} error={item.task?.error ?? (item.transfer ? errors[item.transfer.id] : undefined)} onCancel={() => onCancel(item)} onRetry={() => onRetry(item)} onRefresh={onRefreshDirectory} onDismiss={() => onDismiss(item)} />
					))}
				</div>
			</section>
			<section className="ui-card p-4"><h3 className="text-[11px] font-semibold">{intl.formatMessage({ id: "sftp.queue.behavior" })}</h3><p className="mt-2 text-[10px] leading-5 text-zinc-500">{intl.formatMessage({ id: "sftp.queue.behavior.description" })}</p></section>
		</aside>
	);
}

function SftpTransferQueueCard({ item, busy, error, onCancel, onRetry, onRefresh, onDismiss }: { item: SftpQueueItem; busy: boolean; error?: string; onCancel(): void; onRetry(): void; onRefresh(): void; onDismiss(): void }) {
	const intl = useIntl();
	const { task, transfer } = item;
	const status = transfer?.status;
	const progress = transfer ? (transfer.totalBytes === 0 ? 100 : Math.min(100, Math.round(transfer.bytesTransferred / transfer.totalBytes * 100))) : 0;
	const browserProgress = task ? Math.min(100, Math.round(task.browserBytes / Math.max(1, task.file.size) * 100)) : undefined;
	const active = task?.phase === "creating" || task?.phase === "uploading" || task?.phase === "cancelling" || (transfer !== undefined && isTransferActive(transfer));
	const retryable = transfer ? canRetryTransfer(transfer) && (transfer.direction === "download" || task !== undefined) : task?.phase === "idle" && error !== undefined;
	const uncertain = status === "uncertain";
	const label = intl.formatMessage({ id: task?.phase === "creating" ? "sftp.transfer.creating" : task?.phase === "cancelling" ? "sftp.transfer.cancelling" : status ? transferStatusMessageId(status) : error ? "sftp.transfer.createFailed" : "sftp.transfer.ready" });
	return (
		<div className={`rounded-xl p-3 ${uncertain ? "border border-amber-200 bg-amber-50" : "bg-[#f3f2ee]"}`}>
			<div className="flex items-center gap-2">
				<FileText size={15} className="text-zinc-500" />
				<div className="min-w-0 flex-1"><p className="truncate text-[10px] font-medium">{transfer?.fileName ?? task?.file.name}</p><p className="mt-1 text-[9px] text-zinc-400">{intl.formatMessage({ id: transfer?.direction === "download" ? "sftp.transfer.download" : "sftp.transfer.upload" })} · {busy ? intl.formatMessage({ id: "sftp.transfer.processing" }) : label}</p></div>
				{status === "completed" ? <Check size={13} className="text-[#397b5c]" /> : active ? <button disabled={busy || task?.phase === "cancelling"} onClick={onCancel} aria-label={intl.formatMessage({ id: "sftp.transfer.cancel" })}><X size={13} /></button> : null}
			</div>
			{transfer ? <><div className="mt-2 h-1 overflow-hidden rounded bg-zinc-200"><div className="h-full bg-[#397b5c]" style={{ width: `${progress}%` }} /></div><p className="mt-1 text-[8px] text-zinc-400">{intl.formatMessage({ id: browserProgress === undefined ? "sftp.transfer.progress.remote" : "sftp.transfer.progress" }, { remote: progress, browser: browserProgress ?? 0 })}</p></> : null}
			{error ?? transfer?.failure?.message ? <p className="mt-2 text-[9px] leading-4 text-rose-600">{error ?? transfer?.failure?.message}</p> : null}
			<div className="mt-2 flex gap-3 text-[9px] font-semibold">
				{retryable ? <button className="inline-flex items-center gap-1 text-[#397b5c] disabled:opacity-40" disabled={busy} onClick={onRetry}><RotateCcw size={10} /> {intl.formatMessage({ id: "sftp.transfer.retry" })}</button> : null}
				{uncertain ? <button className="inline-flex items-center gap-1 text-amber-700" onClick={onRefresh}><RefreshCw size={10} /> {intl.formatMessage({ id: "sftp.transfer.refreshDirectory" })}</button> : null}
				{!active && task && !uncertain ? <button className="text-zinc-400" onClick={onDismiss}>{intl.formatMessage({ id: "sftp.transfer.dismiss" })}</button> : null}
			</div>
		</div>
	);
}

function transferStatusMessageId(status: TransferStatus): Parameters<IntlShape["formatMessage"]>[0]["id"] {
	return ({ pending: "sftp.transfer.pending", running: "sftp.transfer.running", completed: "sftp.transfer.completed", failed: "sftp.transfer.failed", cancelled: "sftp.transfer.cancelled", uncertain: "sftp.transfer.uncertain" } as const)[status];
}

export function mergeSftpQueueItems(tasks: UploadTask[], transfers: FileTransfer[]): SftpQueueItem[] {
	const taskTransferIds = new Set(tasks.flatMap((task) => task.transfer ? [task.transfer.id] : []));
	return [
		...tasks.map((task) => ({ key: task.clientId, task, ...(task.transfer ? { transfer: task.transfer } : {}) })),
		...transfers.filter((transfer) => !taskTransferIds.has(transfer.id)).map((transfer) => ({ key: transfer.id, transfer })),
	];
}
