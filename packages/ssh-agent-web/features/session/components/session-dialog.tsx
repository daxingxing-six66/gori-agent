"use client";

import { FolderOpen, X } from "lucide-react";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { LocalDirectoryPicker } from "@/features/session/components/local-directory-picker";
import type { Session } from "@/features/session/model/session";

export function SessionDialog({ session, onClose, onSubmit }: {
	session?: Session;
	onClose(): void;
	onSubmit(input: { displayName: string; workDir?: string | null; autoAudit: boolean }): Promise<void>;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [displayName, setDisplayName] = useState(session?.displayName ?? "");
	const [workDir, setWorkDir] = useState(session?.workDir ?? "");
	const [autoAudit, setAutoAudit] = useState(session?.autoAudit ?? false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);

	return (
		<>
			<div className="fixed inset-0 z-[80] grid place-items-center bg-zinc-950/30 p-5" role="dialog" aria-modal="true">
				<form
					className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
					onSubmit={(event) => {
						event.preventDefault();
						setPending(true);
						setError(null);
						void onSubmit({ displayName: displayName.trim(), workDir: workDir || null, autoAudit })
							.catch((requestError) => setError(localizedErrorMessage(requestError)))
							.finally(() => setPending(false));
					}}
				>
					<h2 className="text-sm font-semibold">{intl.formatMessage({ id: session ? "session.edit" : "session.create" })}</h2>
					<label className="mt-4 block text-[10px] font-semibold text-zinc-500">
						{intl.formatMessage({ id: "session.field.name" })}
						<input className="mt-1.5 h-10 w-full rounded-lg border px-3 text-xs outline-none focus:border-[#397b5c]" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoFocus />
					</label>
					<div className="mt-4">
						<label htmlFor="session-work-dir" className="block text-[10px] font-semibold text-zinc-500">{intl.formatMessage({ id: "session.field.workDir" })}</label>
						<div className="mt-1.5 flex gap-2">
							<div className="relative min-w-0 flex-1">
								<input id="session-work-dir" aria-label={intl.formatMessage({ id: "session.field.workDir" })} readOnly className="h-10 w-full rounded-lg border bg-zinc-50 px-3 pr-9 font-mono text-xs text-zinc-700 outline-none" value={workDir} placeholder={intl.formatMessage({ id: "session.workDir.systemDefault" })} />
								{workDir ? <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700" aria-label={intl.formatMessage({ id: "session.workDir.systemDefault" })} title={intl.formatMessage({ id: "session.workDir.systemDefault" })} disabled={pending} onClick={() => setWorkDir("")}><X size={12} /></button> : null}
							</div>
							<button type="button" className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-[10px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-40" disabled={pending} onClick={() => setDirectoryPickerOpen(true)}><FolderOpen size={13} /> {intl.formatMessage({ id: "session.workDir.choose" })}</button>
						</div>
						<p className="mt-1.5 text-[9px] text-zinc-400">{intl.formatMessage({ id: "session.workDir.hint" })}</p>
					</div>
					<label className="mt-4 flex items-center gap-2 text-[11px] text-zinc-600"><input type="checkbox" checked={autoAudit} onChange={(event) => setAutoAudit(event.target.checked)} />{intl.formatMessage({ id: "session.autoAudit.legacy" })}</label>
					{error ? <p className="mt-3 text-[10px] text-rose-600">{error}</p> : null}
					<div className="mt-5 flex justify-end gap-2"><button type="button" className="rounded-lg border px-4 py-2 text-[10px]" onClick={onClose}>{intl.formatMessage({ id: "common.cancel" })}</button><button type="submit" disabled={pending || !displayName.trim()} className="rounded-lg bg-[#397b5c] px-4 py-2 text-[10px] font-semibold text-white disabled:opacity-40">{intl.formatMessage({ id: pending ? "common.saving" : "common.save" })}</button></div>
				</form>
			</div>
			{directoryPickerOpen ? <LocalDirectoryPicker initialPath={workDir || undefined} onClose={() => setDirectoryPickerOpen(false)} onSelect={(path) => { setWorkDir(path); setDirectoryPickerOpen(false); }} /> : null}
		</>
	);
}
