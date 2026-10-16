"use client";

import { useCallback, useState } from "react";
import { Server } from "lucide-react";
import { useIntl } from "react-intl";
import { DialogError, DialogField, ManagementDialog, dialogInputClass } from "@/components/management-dialog";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { LocalDirectoryPicker } from "@/features/session/components/local-directory-picker";
import { sftpApi } from "@/features/sftp/api/sftp-api";
import { RemoteDirectoryPicker } from "./remote-directory-picker";
import { type Workspace } from "../model/workspace";
import { configuredSandboxWritableRoots, validSandboxWritableRoots } from "../model/sandbox-writable-roots";
import { SandboxWritableRootsField } from "./sandbox-writable-roots-field";
import { WorkspaceDirectoryField, WorkspaceFormSection } from "./workspace-form";

export function WorkspaceEditDialog({ workspace, onClose, onSubmit }: {
	workspace: Workspace;
	onClose(): void;
	onSubmit(input: { displayName: string; defaultCwd: string; sandboxWritableRoots: string[] }): Promise<void>;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [displayName, setDisplayName] = useState(workspace.displayName);
	const [defaultCwd, setDefaultCwd] = useState(workspace.defaultCwd);
	const [sandboxWritableRoots, setSandboxWritableRoots] = useState(() => configuredSandboxWritableRoots(workspace));
	const [choosingSandboxRoots, setChoosingSandboxRoots] = useState(false);
	const rootsError = !validSandboxWritableRoots(sandboxWritableRoots) ? intl.formatMessage({ id: "sandbox.roots.invalid" }) : undefined;
	const [choosingDirectory, setChoosingDirectory] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const browseRemote = useCallback((path: string, signal: AbortSignal) => sftpApi.listDirectory(workspace.id, path, signal), [workspace.id]);

	if (choosingDirectory) return <LocalDirectoryPicker initialPath={defaultCwd} onClose={() => setChoosingDirectory(false)} onSelect={(path) => { setDefaultCwd(path); setChoosingDirectory(false); }} />;

	if (choosingSandboxRoots) return <RemoteDirectoryPicker initialPath={sandboxWritableRoots[0] ?? "/"} load={browseRemote}
		onClose={() => setChoosingSandboxRoots(false)} multiple={{ initialPaths: sandboxWritableRoots,
			onSelect: (roots) => { setSandboxWritableRoots(roots); setChoosingSandboxRoots(false); } }} />;

	const hostname = workspace.host.hostname.includes(":") ? `[${workspace.host.hostname}]` : workspace.host.hostname;
	return <ManagementDialog className="workspace-management-dialog" headerIcon={<Server size={23} strokeWidth={1.6} />}
		title={intl.formatMessage({ id: "workspace.edit" })}
		description={intl.formatMessage({ id: "workspace.edit.description" }, { host: `${hostname}:${workspace.host.port}`, environment: intl.formatMessage({ id: `workspace.environment.${workspace.environment}` }) })}
		onClose={onClose} submitLabel={intl.formatMessage({ id: "common.save" })} submitting={submitting} submitDisabled={rootsError !== undefined} onSubmit={(event) => {
		event.preventDefault();
		if (submitting || rootsError !== undefined) return;
		setSubmitting(true);
		setError(null);
		void onSubmit({ displayName, defaultCwd,  sandboxWritableRoots }).catch((cause: unknown) => setError(localizedErrorMessage(cause))).finally(() => setSubmitting(false));
	}}>
		<DialogError message={error} />
		<WorkspaceFormSection title={intl.formatMessage({ id: "workspace.section.identity" })} description={intl.formatMessage({ id: "workspace.section.identityEditHint" })}>
			<DialogField label={intl.formatMessage({ id: "workspace.field.displayName" })}><input className={dialogInputClass} required autoFocus disabled={submitting} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></DialogField>
		</WorkspaceFormSection>
		<WorkspaceFormSection title={intl.formatMessage({ id: "workspace.section.directories" })} description={intl.formatMessage({ id: "workspace.section.directoriesHint" })}>
			<WorkspaceDirectoryField kind="local" label={intl.formatMessage({ id: "workspace.field.defaultCwd" })} path={defaultCwd}
				hint={intl.formatMessage({ id: "session.workDir.description" })} actionLabel={intl.formatMessage({ id: "session.workDir.chooseLabel" })}
				disabled={submitting} onChoose={() => setChoosingDirectory(true)} />
			<SandboxWritableRootsField roots={sandboxWritableRoots} hint={intl.formatMessage({ id: "sandbox.roots.workspaceHint" })} disabled={submitting} error={rootsError}
				onChoose={() => setChoosingSandboxRoots(true)} onChange={setSandboxWritableRoots} />
		</WorkspaceFormSection>
	</ManagementDialog>;
}
