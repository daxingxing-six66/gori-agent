"use client";

import { useState } from "react";
import { Folder } from "lucide-react";
import { useIntl } from "react-intl";
import { DialogError, DialogField, ManagementDialog, dialogInputClass } from "@/components/management-dialog";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { LocalDirectoryPicker } from "@/features/session/components/local-directory-picker";
import type { Workspace } from "../model/workspace";

export function WorkspaceEditDialog({ workspace, onClose, onSubmit }: {
	workspace: Workspace;
	onClose(): void;
	onSubmit(input: { displayName: string; defaultCwd: string; remoteDefaultCwd: string }): Promise<void>;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [displayName, setDisplayName] = useState(workspace.displayName);
	const [defaultCwd, setDefaultCwd] = useState(workspace.defaultCwd);
	const [remoteDefaultCwd, setRemoteDefaultCwd] = useState(workspace.remoteDefaultCwd ?? "/");
	const [choosingDirectory, setChoosingDirectory] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (choosingDirectory) return <LocalDirectoryPicker initialPath={defaultCwd} onClose={() => setChoosingDirectory(false)} onSelect={(path) => { setDefaultCwd(path); setChoosingDirectory(false); }} />;

	return <ManagementDialog title={intl.formatMessage({ id: "workspace.edit" })} onClose={onClose} submitLabel={intl.formatMessage({ id: "common.save" })} submitting={submitting} onSubmit={(event) => {
		event.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		setError(null);
		void onSubmit({ displayName, defaultCwd, remoteDefaultCwd }).catch((cause: unknown) => setError(localizedErrorMessage(cause))).finally(() => setSubmitting(false));
	}}>
		<DialogError message={error} />
		<DialogField label={intl.formatMessage({ id: "workspace.field.displayName" })}><input className={dialogInputClass} required autoFocus disabled={submitting} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></DialogField>
		<DialogField label={intl.formatMessage({ id: "workspace.field.defaultCwd" })} hint={intl.formatMessage({ id: "session.workDir.description" })}>
			<button type="button" className={`${dialogInputClass} flex items-center gap-2 text-left disabled:opacity-50`} disabled={submitting} aria-label={intl.formatMessage({ id: "session.workDir.chooseLabel" })} onClick={() => setChoosingDirectory(true)}>
				<Folder size={15} className="shrink-0 text-zinc-400" />
				<span className="min-w-0 flex-1 truncate font-mono" title={defaultCwd}>{defaultCwd}</span>
				<span className="shrink-0 text-[10px] text-[#397b5c]">{intl.formatMessage({ id: "session.workDir.chooseLabel" })}</span>
			</button>
		</DialogField>
		<DialogField label={intl.formatMessage({ id: "workspace.field.remoteDefaultCwd" })} hint={intl.formatMessage({ id: "workspace.remoteDefaultCwd.description" })}>
			<input className={dialogInputClass} aria-label={intl.formatMessage({ id: "workspace.field.remoteDefaultCwd" })} required pattern="/.*" value={remoteDefaultCwd} disabled={submitting} onChange={(event) => setRemoteDefaultCwd(event.target.value)} />
		</DialogField>
	</ManagementDialog>;
}
