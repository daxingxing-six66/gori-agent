"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useIntl } from "react-intl";
import {
	ArrowLeft,
	Pencil,
	Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/page-layout";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { CredentialManager } from "@/features/credential/components/credential-manager";
import { GuardEditor } from "@/features/guard/components/guard-editor";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { RealtimeOverviewTab } from "@/features/sftp/components/realtime-overview-tab";
import { SftpFilesTab } from "@/features/sftp/components/sftp-files-tab";
import {
	SftpTransferProvider,
	useSftpTransferManager,
} from "@/features/sftp/components/sftp-transfer-provider";
import { WorkspaceTabNavigation, useWorkspaceTabIds, type WorkspaceTab } from "@/features/workspace/components/workspace-tab-navigation";
import { workspaceApi } from "@/features/workspace/api/workspace-api";
import { WorkspaceEditDialog } from "@/features/workspace/components/workspace-edit-dialog";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";

export function WorkspaceConsole({ workspaceId }: { workspaceId: string }) {
	return <SftpTransferProvider key={workspaceId} workspaceId={workspaceId}><WorkspaceConsoleContent workspaceId={workspaceId} /></SftpTransferProvider>;
}

function WorkspaceConsoleContent({ workspaceId }: { workspaceId: string }) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const router = useRouter();
	const { tree, loading, error, refresh } = useWorkspaceTree();
	const transferManager = useSftpTransferManager();
	const { tabId, panelId } = useWorkspaceTabIds();
	const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
	const [editDialogOpen, setEditDialogOpen] = useState(false);
	const [mutationError, setMutationError] = useState<string | null>(null);
	const treeItem = tree?.workspaces.find((item) => item.workspace.id === workspaceId);

	if (!treeItem) {
		return <div className="app-layout"><WorkspaceSidebar activeWorkspaceId={workspaceId} /><main className="grid min-w-0 flex-1 place-items-center bg-[var(--panel)] p-8"><div className="max-w-md text-center"><h1 className="text-[15px] font-semibold">{intl.formatMessage({ id: loading ? "workspace.loading" : "workspace.notFound" })}</h1><p className="mt-2 text-[10px] leading-5 text-zinc-500">{error ? localizedErrorMessage(error) : intl.formatMessage({ id: loading ? "workspace.tree.loading" : "workspace.possiblyDeleted" })}</p>{!loading ? <button className="mt-4 rounded-lg bg-[#397b5c] px-4 py-2 text-[10px] font-semibold text-white" onClick={() => { void refresh(); router.push("/"); }}>{intl.formatMessage({ id: "workspace.backToTree" })}</button> : null}</div></main></div>;
	}

	const { workspace, sessions } = treeItem;
	const hostAddress = workspace.host.hostname;

	return (
		<><div className="app-layout">
			<WorkspaceSidebar activeWorkspaceId={workspace.id} />
			<main className="page-main page-main-workspace">
				<PageHeader
					title={workspace.displayName}
					subtitle={`${hostAddress}:${workspace.host.port}`}
					leading={<Link href="/" className="page-icon-button" aria-label={intl.formatMessage({ id: "workspace.backToSessions" })} onClick={(event) => { if (!transferManager.confirmNavigation()) event.preventDefault(); }}><ArrowLeft size={15} /></Link>}
					meta={<span className="page-environment">{intl.formatMessage({ id: `workspace.environment.${workspace.environment}` })}</span>}
					actions={<>
						<button type="button" className="page-icon-button" aria-label={intl.formatMessage({ id: "workspace.edit" })} title={intl.formatMessage({ id: "workspace.edit" })} onClick={() => setEditDialogOpen(true)}><Pencil size={14} /></button>
						<button type="button" className="page-icon-button page-icon-button-danger" disabled={sessions.length > 0} title={intl.formatMessage({ id: sessions.length > 0 ? "workspace.delete.blocked" : "workspace.delete" })} aria-label={intl.formatMessage({ id: "workspace.delete" })} onClick={() => {
							if (!transferManager.confirmNavigation()) return;
							if (!window.confirm(intl.formatMessage({ id: "workspace.delete.confirm" }, { name: workspace.displayName }))) return;
							void workspaceApi.delete(workspace.id, workspace.revision).then(async () => { await refresh(); router.push("/"); }).catch((requestError: unknown) => { setMutationError(localizedErrorMessage(requestError)); void refresh(); });
						}}><Trash2 size={14} /></button>
					</>}
				/>
				<WorkspaceTabNavigation activeTab={activeTab} onChange={setActiveTab} tabId={tabId} panelId={panelId} />
				{mutationError ? <button className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-left text-[10px] text-rose-700" onClick={() => setMutationError(null)}>{mutationError}</button> : null}

				<div className={`page-content app-scrollbar ${activeTab === "overview" ? "page-content-dashboard" : ""}`}>
					<div className="page-content-inner" role="tabpanel" id={panelId} aria-labelledby={tabId(activeTab)} tabIndex={0}>
						{activeTab === "overview" ? <RealtimeOverviewTab workspace={workspace} /> : null}
						{activeTab === "guard" ? <GuardEditor workspaceId={workspace.id} /> : null}
						{activeTab === "credentials" ? <CredentialManager workspaceId={workspace.id} /> : null}
						{activeTab === "files" ? <SftpFilesTab workspaceId={workspace.id} defaultCwd={workspace.remoteDefaultCwd ?? "/"} hostLabel={hostAddress} /> : null}
					</div>
				</div>
			</main>
		</div>{editDialogOpen ? <WorkspaceEditDialog workspace={workspace} onClose={() => setEditDialogOpen(false)} onSubmit={async (input) => { await workspaceApi.update(workspace.id, { ...input, expectedRevision: workspace.revision }); setEditDialogOpen(false); await refresh(); }} /> : null}</>
	);
}
