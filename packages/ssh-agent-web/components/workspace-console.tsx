"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useIntl } from "react-intl";
import {
	ArrowLeft,
	FolderOpen,
	Gauge,
	KeyRound,
	Pencil,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { CredentialManager } from "@/features/credential/components/credential-manager";
import { GuardEditor } from "@/features/guard/components/guard-editor";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import type { MessageId } from "@/features/i18n/messages/zh-CN";
import { RealtimeOverviewTab } from "@/features/sftp/components/realtime-overview-tab";
import { SftpFilesTab } from "@/features/sftp/components/sftp-files-tab";
import {
	SftpTransferProvider,
	useSftpTransferManager,
} from "@/features/sftp/components/sftp-transfer-provider";
import { workspaceApi } from "@/features/workspace/api/workspace-api";
import { WorkspaceEditDialog } from "@/features/workspace/components/workspace-edit-dialog";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";

const workspaceTabs: readonly { id: "overview" | "guard" | "credentials" | "files"; labelId: MessageId; icon: typeof Gauge }[] = [
	{ id: "overview", labelId: "workspace.tabs.overview", icon: Gauge },
	{ id: "guard", labelId: "workspace.tabs.guard", icon: ShieldCheck },
	{ id: "credentials", labelId: "workspace.tabs.credentials", icon: KeyRound },
	{ id: "files", labelId: "workspace.tabs.files", icon: FolderOpen },
] as const;

type WorkspaceTab = (typeof workspaceTabs)[number]["id"];

export function WorkspaceConsole({ workspaceId }: { workspaceId: string }) {
	return <SftpTransferProvider key={workspaceId} workspaceId={workspaceId}><WorkspaceConsoleContent workspaceId={workspaceId} /></SftpTransferProvider>;
}

function WorkspaceConsoleContent({ workspaceId }: { workspaceId: string }) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const router = useRouter();
	const { tree, loading, error, refresh } = useWorkspaceTree();
	const transferManager = useSftpTransferManager();
	const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
	const [editDialogOpen, setEditDialogOpen] = useState(false);
	const [mutationError, setMutationError] = useState<string | null>(null);
	const treeItem = tree?.workspaces.find((item) => item.workspace.id === workspaceId);

	if (!treeItem) {
		return <div className="flex h-dvh min-h-[640px] min-w-[320px] overflow-hidden bg-[var(--canvas)]"><WorkspaceSidebar activeWorkspaceId={workspaceId} /><main className="grid min-w-0 flex-1 place-items-center bg-[var(--panel)] p-8"><div className="max-w-md text-center"><h1 className="text-[15px] font-semibold">{intl.formatMessage({ id: loading ? "workspace.loading" : "workspace.notFound" })}</h1><p className="mt-2 text-[10px] leading-5 text-zinc-500">{error ? localizedErrorMessage(error) : intl.formatMessage({ id: loading ? "workspace.tree.loading" : "workspace.possiblyDeleted" })}</p>{!loading ? <button className="mt-4 rounded-lg bg-[#397b5c] px-4 py-2 text-[10px] font-semibold text-white" onClick={() => { void refresh(); router.push("/"); }}>{intl.formatMessage({ id: "workspace.backToTree" })}</button> : null}</div></main></div>;
	}

	const { workspace, sessions } = treeItem;
	const hostAddress = workspace.host.hostname;

	return (
		<><div className="flex h-dvh min-h-[640px] min-w-[320px] overflow-hidden bg-[var(--canvas)]">
			<WorkspaceSidebar activeWorkspaceId={workspace.id} />
			<main className="flex min-w-0 flex-1 flex-col bg-[var(--panel)]">
				<header className="workspace-console-header flex h-16 shrink-0 items-center gap-3 border-b border-[var(--line-soft)] bg-[var(--surface)] px-4 lg:px-6">
					<div className="flex min-w-0 shrink-0 items-center gap-2"><Link href="/" className="shrink-0 rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "workspace.backToSessions" })} onClick={(event) => { if (!transferManager.confirmNavigation()) event.preventDefault(); }}><ArrowLeft size={17} /></Link><div className="min-w-0"><h1 className="max-w-[150px] truncate text-[14px] font-semibold text-[var(--ink)]">{workspace.displayName}</h1><p className="max-w-[150px] truncate font-mono text-[11px] text-[var(--text-muted)]">{hostAddress}:{workspace.host.port}</p></div></div>
					<nav className="workspace-console-tabs app-scrollbar flex h-full min-w-0 flex-1 gap-1 overflow-x-auto" aria-label={intl.formatMessage({ id: "workspace.pages" })}>
						{workspaceTabs.map((tab) => { const Icon = tab.icon; return <button key={tab.id} className={`flex h-full shrink-0 items-center gap-2 border-b-2 px-3 text-[12px] font-medium transition ${activeTab === tab.id ? "border-[var(--accent)] text-[var(--ink)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--ink)]"}`} aria-current={activeTab === tab.id ? "page" : undefined} onClick={() => setActiveTab(tab.id)}><Icon size={15} /> {intl.formatMessage({ id: tab.labelId })}</button>; })}
					</nav>
					<div className="workspace-console-actions flex shrink-0 items-center gap-2"><button className="rounded-lg border border-[var(--line)] p-2 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "workspace.edit" })} onClick={() => setEditDialogOpen(true)}><Pencil size={14} /></button><button className="rounded-lg border border-[var(--line)] p-2 text-[var(--text-muted)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40" disabled={sessions.length > 0} title={intl.formatMessage({ id: sessions.length > 0 ? "workspace.delete.blocked" : "workspace.delete" })} aria-label={intl.formatMessage({ id: "workspace.delete" })} onClick={() => {
						if (!transferManager.confirmNavigation()) return;
						if (!window.confirm(intl.formatMessage({ id: "workspace.delete.confirm" }, { name: workspace.displayName }))) return;
						void workspaceApi.delete(workspace.id, workspace.revision).then(async () => { await refresh(); router.push("/"); }).catch((requestError: unknown) => { setMutationError(localizedErrorMessage(requestError)); void refresh(); });
					}}><Trash2 size={14} /></button></div>
				</header>
				{mutationError ? <button className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-left text-[10px] text-rose-700" onClick={() => setMutationError(null)}>{mutationError}</button> : null}

				<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-6 xl:p-8">
					<div className="mx-auto w-full max-w-[1440px]">
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
