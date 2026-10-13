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
		<div className="sftp-entries-scroll app-scrollbar">
			<table className="sftp-entries-table">
				<thead><tr><th>{intl.formatMessage({ id: "sftp.table.name" })}</th><th>{intl.formatMessage({ id: "sftp.table.size" })}</th><th>{intl.formatMessage({ id: "sftp.table.modified" })}</th><th><span className="sr-only">{intl.formatMessage({ id: "sftp.table.actions" })}</span></th></tr></thead>
				<tbody>{entries.length === 0 ? <tr><td colSpan={4} className="sftp-entries-empty">{emptyMessage}</td></tr> : entries.map((entry) => (
					<tr key={entry.path}>
						<td><button className="sftp-entry-name" title={entry.name} disabled={entry.type !== "directory" || busy[entry.path]} onClick={() => onOpen(entry)}>
							{entry.type === "directory" ? <Folder size={14} className="text-[var(--accent)]" aria-hidden="true" /> : entry.type === "symlink" ? <LinkIcon size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}<span>{entry.name}</span>
						</button>{errors[entry.path] ? <p className="mt-1 text-[11px] text-[var(--danger)]" role="alert">{errors[entry.path]}</p> : null}</td>
						<td>{entry.type === "directory" ? "—" : formatBytes(entry.size)}</td><td>{formatDate(entry.modifiedAt, intl.locale)}</td>
						<td><div className="flex justify-end gap-1">
							{entry.type === "file" ? <button className="page-icon-button" disabled={busy[entry.path]} aria-label={intl.formatMessage({ id: "sftp.download" }, { name: entry.name })} onClick={() => onDownload(entry)}><Download size={13} /></button> : null}
							{entry.type === "file" || entry.type === "symlink" ? <button className="page-icon-button page-icon-button-danger" disabled={busy[entry.path]} aria-label={intl.formatMessage({ id: "sftp.delete" }, { name: entry.name })} onClick={() => onDelete(entry)}><Trash2 size={13} /></button> : null}
						</div></td>
					</tr>
				))}</tbody>
			</table>
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
