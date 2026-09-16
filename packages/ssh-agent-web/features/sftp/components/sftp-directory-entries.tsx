import { Download, FileText, Folder, Link as LinkIcon, Trash2 } from "lucide-react";
import { useIntl } from "react-intl";
import type { SftpDirectoryEntry } from "@/features/sftp/model/sftp";

interface SftpDirectoryEntriesProps {
	entries: SftpDirectoryEntry[];
	busy: Record<string, boolean>;
	errors: Record<string, string>;
	emptyMessage: string;
	onOpen(entry: SftpDirectoryEntry): void;
	onDownload(entry: SftpDirectoryEntry): void;
	onDelete(entry: SftpDirectoryEntry): void;
}

export function SftpDirectoryEntries({
	entries,
	busy,
	errors,
	emptyMessage,
	onOpen,
	onDownload,
	onDelete,
}: SftpDirectoryEntriesProps) {
	const intl = useIntl();
	return (
		<div className="p-3">
			<div className="grid grid-cols-[minmax(0,1fr)_90px_130px_76px] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
				<span>{intl.formatMessage({ id: "sftp.table.name" })}</span><span>{intl.formatMessage({ id: "sftp.table.size" })}</span><span>{intl.formatMessage({ id: "sftp.table.modified" })}</span><span />
			</div>
			{entries.length === 0 ? <p className="py-16 text-center text-[10px] text-zinc-400">{emptyMessage}</p> : entries.map((entry) => (
				<div key={entry.path} className="rounded-xl px-3 py-2 hover:bg-zinc-50">
					<div className="grid grid-cols-[minmax(0,1fr)_90px_130px_76px] items-center text-[11px]">
						<button className="flex min-w-0 items-center gap-3 text-left" disabled={entry.type !== "directory" || busy[entry.path]} onClick={() => onOpen(entry)}>
							<span className={`grid h-8 w-8 place-items-center rounded-lg ${entry.type === "directory" ? "bg-amber-50 text-amber-500" : "bg-zinc-100 text-zinc-500"}`}>
								{entry.type === "directory" ? <Folder size={15} /> : entry.type === "symlink" ? <LinkIcon size={15} /> : <FileText size={15} />}
							</span>
							<span className="truncate font-medium text-zinc-700">{entry.name}</span>
						</button>
						<span className="text-zinc-400">{entry.type === "directory" ? "—" : formatBytes(entry.size)}</span>
						<span className="text-zinc-400">{formatDate(entry.modifiedAt, intl.locale)}</span>
						<span className="flex justify-end gap-1">
							{entry.type === "file" ? <button className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 disabled:opacity-40" disabled={busy[entry.path]} aria-label={intl.formatMessage({ id: "sftp.download" }, { name: entry.name })} onClick={() => onDownload(entry)}><Download size={14} /></button> : null}
							{entry.type === "file" || entry.type === "symlink" ? <button className="rounded-lg p-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40" disabled={busy[entry.path]} aria-label={intl.formatMessage({ id: "sftp.delete" }, { name: entry.name })} onClick={() => onDelete(entry)}><Trash2 size={14} /></button> : null}
						</span>
					</div>
					{errors[entry.path] ? <p className="mt-1 pl-11 text-[9px] text-rose-600">{errors[entry.path]}</p> : null}
				</div>
			))}
		</div>
	);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatDate(timestamp: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(timestamp);
}
