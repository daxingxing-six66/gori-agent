"use client";

import { FolderOpen, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { DialogError, ManagementDialog, dialogInputClass } from "@/components/management-dialog";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { LocalDirectoryPicker } from "@/features/session/components/local-directory-picker";
import type { Session } from "@/features/session/model/session";
import { sftpApi } from "@/features/sftp/api/sftp-api";
import { RemoteDirectoryPicker } from "@/features/workspace/components/remote-directory-picker";
import { SandboxWritableRootsField } from "@/features/workspace/components/sandbox-writable-roots-field";
import { configuredSandboxWritableRoots, validSandboxWritableRoots } from "@/features/workspace/model/sandbox-writable-roots";
import type { Workspace } from "@/features/workspace/model/workspace";

export interface SessionDialogInput {
	displayName: string;
	workDir: string | null;
	autoAudit: boolean;
	sandboxWritableRoots?: string[];
}

export function SessionDialog({ session, workspace, onClose, onReload, onSubmit }: {
	session?: Session;
	workspace?: Workspace;
	onClose(): void;
	onReload?(): void;
	onSubmit(input: SessionDialogInput): Promise<void>;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [displayName, setDisplayName] = useState(session?.displayName ?? "");
	const [workDir, setWorkDir] = useState(session?.workDir ?? "");
	const [autoAudit, setAutoAudit] = useState(session?.autoAudit ?? false);
	const initialRoots = session?.sandboxWritableRoots ?? (workspace ? configuredSandboxWritableRoots(workspace) : []);
	const [roots, setRoots] = useState(initialRoots);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [picker, setPicker] = useState<"local" | "remote" | null>(null);
	const rootsChanged = roots.length !== initialRoots.length || roots.some((root, index) => root !== initialRoots[index]);
	const rootsInvalid = rootsChanged && !validSandboxWritableRoots(roots);
	const defaults = workspace ? configuredSandboxWritableRoots(workspace) : [];
	const loadRemote = useCallback((path: string, signal: AbortSignal) => {
		if (!workspace) throw new Error("Session directory browsing requires a Workspace");
		return sftpApi.listDirectory(workspace.id, path, signal);
	}, [workspace]);
	const close = () => { if (!pending) onClose(); };

	if (picker === "local") return <LocalDirectoryPicker initialPath={workDir || undefined} onClose={() => setPicker(null)} onSelect={(path) => { setWorkDir(path); setPicker(null); }} />;
	if (picker === "remote" && workspace) return <RemoteDirectoryPicker initialPath={roots[0] ?? "/"} load={loadRemote}
		onClose={() => setPicker(null)} multiple={{ initialPaths: roots, onSelect: (selected) => { setRoots(selected); setPicker(null); } }} />;

	return (
		<ManagementDialog title={intl.formatMessage({ id: session ? "session.edit" : "session.create" })} onClose={close}
			submitting={pending} submitDisabled={!displayName.trim() || rootsInvalid} submitLabel={intl.formatMessage({ id: "common.save" })}
			onSubmit={(event) => {
				event.preventDefault();
				if (pending || !displayName.trim() || rootsInvalid) return;
				setPending(true);
				setError(null);
				void onSubmit({ displayName: displayName.trim(), workDir: workDir || null, autoAudit,
					...(rootsChanged ? { sandboxWritableRoots: roots } : {}) })
					.catch((requestError) => setError(localizedErrorMessage(requestError)))
					.finally(() => setPending(false));
			}}>
			<DialogError message={error} />
			{error && onReload ? <button type="button" className="text-xs text-accent" disabled={pending} onClick={onReload}>{intl.formatMessage({ id: "sandbox.roots.reload" })}</button> : null}
			<label className="block text-[10px] font-semibold text-secondary">
				{intl.formatMessage({ id: "session.field.name" })}
				<input className={`mt-1.5 w-full ${dialogInputClass}`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={pending} autoFocus />
			</label>
			<div>
				<label htmlFor="session-work-dir" className="block text-[10px] font-semibold text-secondary">{intl.formatMessage({ id: "session.field.workDir" })}</label>
				<div className="mt-1.5 flex gap-2">
					<div className="relative min-w-0 flex-1">
						<input id="session-work-dir" aria-label={intl.formatMessage({ id: "session.field.workDir" })} readOnly className={`${dialogInputClass} w-full pr-9 font-mono`} value={workDir} placeholder={intl.formatMessage({ id: "session.workDir.systemDefault" })} />
						{workDir ? <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:bg-surface-hover hover:text-secondary" aria-label={intl.formatMessage({ id: "session.workDir.systemDefault" })} title={intl.formatMessage({ id: "session.workDir.systemDefault" })} disabled={pending} onClick={() => setWorkDir("")}><X size={12} /></button> : null}
					</div>
					<button type="button" className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 text-[10px] font-semibold text-secondary hover:bg-surface-hover disabled:opacity-40" disabled={pending} onClick={() => setPicker("local")}><FolderOpen size={13} /> {intl.formatMessage({ id: "session.workDir.choose" })}</button>
				</div>
				<p className="mt-1.5 text-[9px] text-faint">{intl.formatMessage({ id: "session.workDir.hint" })}</p>
			</div>
			{session && workspace ? <div className="space-y-2 border-t border-[var(--line-soft)] pt-4">
				<SandboxWritableRootsField roots={roots} hint={intl.formatMessage({ id: "sandbox.roots.sessionHint" })} disabled={pending}
					error={rootsInvalid ? intl.formatMessage({ id: "sandbox.roots.invalid" }) : undefined}
					onChoose={() => setPicker("remote")} onChange={setRoots} />
				<button type="button" className="text-[11px] text-accent disabled:opacity-40" disabled={pending || defaults.length === 0} onClick={() => setRoots(defaults)}>{intl.formatMessage({ id: "sandbox.roots.useWorkspace" })}</button>
				{rootsChanged && session.sandboxEnabled ? <p className="text-[11px] text-secondary">{intl.formatMessage({ id: "session.sandbox.restarting" })}</p> : null}
			</div> : null}
			<label className="flex items-center gap-2 text-[11px] text-secondary"><input type="checkbox" checked={autoAudit} disabled={pending} onChange={(event) => setAutoAudit(event.target.checked)} />{intl.formatMessage({ id: "session.autoAudit.legacy" })}</label>
		</ManagementDialog>
	);
}
