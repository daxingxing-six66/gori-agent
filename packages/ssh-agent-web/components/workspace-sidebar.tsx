"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useIntl } from "react-intl";
import {
	ChevronRight,
	CirclePlus,
	Command,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Server,
	Settings,
	Settings2,
	Trash2,
} from "lucide-react";
import { useSettings } from "@/features/settings/components/settings-context";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { sessionApi } from "@/features/session/api/session-api";
import { SessionDeleteDialog } from "@/features/session/components/session-delete-dialog";
import { SessionDialog } from "@/features/session/components/session-dialog";
import type { Session } from "@/features/session/model/session";
import { useSftpTransferManagerOptional } from "@/features/sftp/components/sftp-transfer-provider";
import { WorkspaceDialog } from "@/features/workspace/components/workspace-dialog";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";

interface WorkspaceSidebarProps {
	activeWorkspaceId?: string;
	activeSessionId?: string;
}

export function WorkspaceSidebar({ activeWorkspaceId, activeSessionId }: WorkspaceSidebarProps) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const router = useRouter();
	const { tree, loading, error, refresh } = useWorkspaceTree();
	const { openSettings } = useSettings();
	const transferManager = useSftpTransferManagerOptional();
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([]);
	const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
	const [renameSession, setRenameSession] = useState<Session | null>(null);
	const [deleteSession, setDeleteSession] = useState<Session | null>(null);
	const [deletingSession, setDeletingSession] = useState(false);
	const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
	const [mutationError, setMutationError] = useState<string | null>(null);

	const toggleWorkspace = (workspaceId: string) => {
		setExpandedWorkspaceIds((expandedIds) =>
			expandedIds.includes(workspaceId)
				? expandedIds.filter((id) => id !== workspaceId)
				: [...expandedIds, workspaceId],
		);
	};

	return (
		<>
			<aside className={`workspace-sidebar flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-[var(--line)] bg-[var(--sidebar)] text-zinc-800 transition-[width] duration-200 ease-out ${sidebarCollapsed ? "w-14" : "w-[292px]"}`}>
				{sidebarCollapsed ? (
					<>
						<div className="flex h-[64px] w-14 shrink-0 items-center justify-center border-b border-[var(--line)]">
							<button className="rounded-lg p-2 text-zinc-400 transition hover:bg-black/[0.04] hover:text-zinc-700" aria-label={intl.formatMessage({ id: "sidebar.expand" })} title={intl.formatMessage({ id: "sidebar.expand" })} aria-expanded={false} onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={18} /></button>
						</div>
						<div className="flex flex-1 items-end justify-center pb-4">
							<button className="grid h-9 w-9 place-items-center rounded-xl text-zinc-500 transition hover:bg-black/[0.05] hover:text-zinc-800" aria-label={intl.formatMessage({ id: "sidebar.openSettings" })} title={intl.formatMessage({ id: "sidebar.settings" })} onClick={openSettings}><Settings size={17} /></button>
						</div>
					</>
				) : (
					<>
						<div className="flex h-[64px] items-center gap-3 border-b border-[var(--line)] px-5">
							<div className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--accent)] text-white"><Command size={19} strokeWidth={2.5} /></div>
							<div className="min-w-0 flex-1"><p className="truncate text-[15px] font-semibold tracking-[-0.01em]">Gori</p><p className="text-[10px] text-zinc-400">Personal SSH agent</p></div>
							<button className="rounded-lg p-2 text-zinc-400 transition hover:bg-black/[0.04] hover:text-zinc-700" aria-label={intl.formatMessage({ id: "sidebar.collapse" })} title={intl.formatMessage({ id: "sidebar.collapse" })} aria-expanded={true} onClick={() => setSidebarCollapsed(true)}><PanelLeftClose size={17} /></button>
						</div>

						<div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-4">
							<div className="mb-3 flex items-center justify-between px-1">
								<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{intl.formatMessage({ id: "sidebar.workspaces" })}</span>
								<button className="rounded-md p-1 text-zinc-400 hover:bg-black/[0.04] hover:text-zinc-700" aria-label={intl.formatMessage({ id: "sidebar.workspace.create" })} onClick={() => setWorkspaceDialogOpen(true)}><CirclePlus size={16} /></button>
							</div>
							{error ? <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-[9px] leading-4 text-rose-700"><p>{localizedErrorMessage(error)}</p><button className="mt-1 font-semibold underline" onClick={() => void refresh()}>{intl.formatMessage({ id: "common.reload" })}</button></div> : null}
							{mutationError ? <button className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-left text-[9px] leading-4 text-rose-700" onClick={() => setMutationError(null)}>{mutationError}</button> : null}
							{loading && tree === null ? <p className="px-2 py-4 text-[10px] text-zinc-400">{intl.formatMessage({ id: "workspace.loading" })}</p> : null}
							<div className="app-scrollbar min-h-0 space-y-2 overflow-y-auto">
								{tree?.workspaces.map(({ workspace, sessions }) => {
									const activeWorkspace = activeWorkspaceId === workspace.id;
									const expanded = activeWorkspace || expandedWorkspaceIds.includes(workspace.id);
									const sessionListId = `${workspace.id}-sessions`;

									return (
										<section key={workspace.id} className="py-0.5">
											<div className={`flex items-center gap-0.5 rounded-lg transition ${activeWorkspace ? "bg-black/[0.025] text-zinc-900" : "text-zinc-500 hover:bg-black/[0.035] hover:text-zinc-800"}`}>
											<button type="button" className="ml-1 grid h-8 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition hover:bg-white/70 hover:text-zinc-700" onClick={() => toggleWorkspace(workspace.id)} aria-label={intl.formatMessage({ id: expanded ? "sidebar.workspace.sessions.collapse" : "sidebar.workspace.sessions.expand" }, { name: workspace.displayName })} aria-expanded={expanded} aria-controls={sessionListId}>
													<ChevronRight size={13} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
												</button>
											<Link href={`/workspaces/${workspace.id}/chat/new`} className="group flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-1 text-left" aria-label={intl.formatMessage({ id: "sidebar.workspace.newSession" }, { name: workspace.displayName })} onClick={(event) => { if (transferManager && !transferManager.confirmNavigation()) event.preventDefault(); }}>
													<div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${activeWorkspace ? "bg-[#e7f0e9] text-[#397b5c]" : "bg-[#e7e6e1] text-zinc-500"}`}><Server size={16} /></div>
											<div className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{workspace.displayName}</span><p className="truncate pt-0.5 font-mono text-[9px] text-zinc-400">{workspace.host.hostname}:{workspace.host.port}</p></div>
													<span className="shrink-0 rounded-md bg-[#eeede8] px-1.5 py-0.5 text-[9px] font-medium text-zinc-500">{sessions.length}</span>
												</Link>
											<Link href={`/workspaces/${workspace.id}`} className="rounded-lg p-2 text-zinc-400 transition hover:bg-black/[0.04] hover:text-zinc-800" aria-label={intl.formatMessage({ id: "workspace.console.open" }, { name: workspace.displayName })} title={intl.formatMessage({ id: "workspace.console" })} onClick={(event) => { if (transferManager && !transferManager.confirmNavigation()) event.preventDefault(); }}><Settings2 size={14} /></Link>
											</div>

											{expanded ? (
												<div id={sessionListId} className="mb-2 ml-[47px] mr-2 mt-1.5">
													<div className="space-y-0.5">
														{sessions.map((session) => {
															const activeSession = activeSessionId === session.id;
															return (
																<div key={session.id} className={`group flex min-h-10 w-full items-center overflow-hidden rounded-lg transition ${activeSession ? "bg-[#e7f0e9] text-[#2f6f52]" : "text-zinc-600 hover:bg-black/[0.035] hover:text-zinc-900"}`}>
																	<Link href={`/sessions/${session.id}`} aria-current={activeSession ? "page" : undefined} className="flex min-w-0 flex-1 self-stretch items-center px-2.5 py-2"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeSession ? "bg-[#397b5c]" : "bg-zinc-300"}`} /><span className="ml-2 min-w-0 flex-1 truncate text-[12px] font-semibold">{session.displayName}</span></Link>
																	<button className="rounded p-1 opacity-0 hover:bg-white group-hover:opacity-100" aria-label={intl.formatMessage({ id: "sidebar.session.rename" }, { name: session.displayName })} onClick={() => setRenameSession(session)}><Pencil size={10} /></button>
																	<button className="mr-1 rounded p-1 opacity-0 hover:bg-white hover:text-rose-600 group-hover:opacity-100" aria-label={intl.formatMessage({ id: "sidebar.session.delete" }, { name: session.displayName })} onClick={() => { setDeleteSessionError(null); setDeleteSession(session); }}><Trash2 size={10} /></button>
																</div>
															);
														})}
													</div>
												</div>
											) : null}
										</section>
									);
								})}
							</div>
						</div>

						<div className="border-t border-[var(--line)] p-4"><button className="grid h-9 w-9 place-items-center rounded-xl text-zinc-500 transition hover:bg-black/[0.05] hover:text-zinc-800" aria-label={intl.formatMessage({ id: "sidebar.openSettings" })} title={intl.formatMessage({ id: "sidebar.settings" })} onClick={openSettings}><Settings size={17} /></button></div>
					</>
				)}
			</aside>
			{workspaceDialogOpen ? <WorkspaceDialog onClose={() => setWorkspaceDialogOpen(false)} onCreated={(workspace) => { setWorkspaceDialogOpen(false); void refresh(); if (!transferManager || transferManager.confirmNavigation()) router.push(`/workspaces/${workspace.id}`); }} /> : null}
			{renameSession ? <SessionDialog session={renameSession} onClose={() => setRenameSession(null)} onSubmit={async (input) => { await sessionApi.update(renameSession.id, { ...input, expectedRevision: renameSession.revision }); setRenameSession(null); await refresh(); }} /> : null}
			{deleteSession ? <SessionDeleteDialog session={deleteSession} deleting={deletingSession} error={deleteSessionError ?? undefined} onClose={() => { setDeleteSession(null); setDeleteSessionError(null); }} onConfirm={async () => {
				setDeletingSession(true);
				setDeleteSessionError(null);
				try {
					await sessionApi.delete(deleteSession.id, deleteSession.revision);
					await refresh();
					setDeleteSession(null);
					if (activeSessionId === deleteSession.id) router.replace(`/workspaces/${deleteSession.workspaceId}/chat/new`);
				} catch (requestError) {
					setDeleteSessionError(localizedErrorMessage(requestError));
					await refresh();
				} finally {
					setDeletingSession(false);
				}
			}} /> : null}
		</>
	);
}
