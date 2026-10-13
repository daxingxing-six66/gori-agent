"use client";

import Link from "next/link";
import "./page-layout.css";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
	ChevronRight,
	CirclePlus,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Server,
	Settings,
	Settings2,
	Trash2,
	X,
} from "lucide-react";
import { useSettings } from "@/features/settings/components/settings-context";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { sessionApi } from "@/features/session/api/session-api";
import { SessionDeleteDialog } from "@/features/session/components/session-delete-dialog";
import { SessionEditDialog } from "@/features/session/components/session-edit-dialog";
import type { Session } from "@/features/session/model/session";
import { useSftpTransferManagerOptional } from "@/features/sftp/components/sftp-transfer-provider";
import { WorkspaceDialog } from "@/features/workspace/components/workspace-dialog";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";

interface WorkspaceSidebarProps {
	activeWorkspaceId?: string;
	activeSessionId?: string;
	homePage?: boolean;
	onSessionUpdated?(sessionId: string): Promise<unknown>;
}

export function WorkspaceSidebar({ activeWorkspaceId, activeSessionId, homePage = false, onSessionUpdated }: WorkspaceSidebarProps) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const router = useRouter();
	const { tree, loading, error, refresh, workspaceExpansion, setWorkspaceExpanded } = useWorkspaceTree();
	const { openSettings } = useSettings();
	const transferManager = useSftpTransferManagerOptional();
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [mobileOpen, setMobileOpen] = useState(false);
	const mobileTriggerRef = useRef<HTMLButtonElement>(null);
	const mobileCloseRef = useRef<HTMLButtonElement>(null);
	const mobileWasOpenRef = useRef(false);
	const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
	const [editSession, setEditSession] = useState<Session | null>(null);
	const [deleteSession, setDeleteSession] = useState<Session | null>(null);
	const [deletingSession, setDeletingSession] = useState(false);
	const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
	const [mutationError, setMutationError] = useState<string | null>(null);
	const editedWorkspace = tree?.workspaces.find(({ workspace }) => workspace.id === editSession?.workspaceId)?.workspace;
	const refreshEditedSession = async (id: string) => {
		await refresh();
		await onSessionUpdated?.(id);
	};

	useEffect(() => {
		if (activeWorkspaceId && workspaceExpansion[activeWorkspaceId] === undefined) {
			setWorkspaceExpanded(activeWorkspaceId, true);
		}
	}, [activeWorkspaceId, workspaceExpansion, setWorkspaceExpanded]);

	useEffect(() => {
		if (!mobileOpen) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMobileOpen(false);
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [mobileOpen]);

	useLayoutEffect(() => {
		if (mobileOpen) {
			mobileWasOpenRef.current = true;
			mobileCloseRef.current?.focus();
		} else if (mobileWasOpenRef.current) {
			mobileTriggerRef.current?.focus();
			mobileWasOpenRef.current = false;
		}
	}, [mobileOpen]);

	const openMobileSidebar = () => {
		setSidebarCollapsed(false);
		setMobileOpen(true);
	};

	return (
		<>
			{!homePage ? <button ref={mobileTriggerRef} type="button" className="mobile-sidebar-trigger" aria-label={intl.formatMessage({ id: "sidebar.expand" })} aria-controls="workspace-sidebar-nav" aria-expanded={mobileOpen} onClick={openMobileSidebar}><PanelLeftOpen size={20} /></button> : null}
			{mobileOpen ? <button type="button" tabIndex={-1} className="mobile-sidebar-backdrop" aria-label={intl.formatMessage({ id: "sidebar.collapse" })} onClick={() => setMobileOpen(false)} /> : null}
			<aside id="workspace-sidebar-nav" className={`workspace-sidebar flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-[var(--line)] bg-[var(--sidebar)] text-[var(--ink)] transition-[width] duration-200 ease-out ${sidebarCollapsed ? "w-11" : "w-[256px]"} ${homePage ? "workspace-sidebar-home" : ""} ${mobileOpen ? "workspace-sidebar-mobile-open" : ""}`}>
				{sidebarCollapsed ? (
					<>
						<div className="sidebar-brand-header flex w-full shrink-0 items-center justify-center border-b border-[var(--line)]">
							<button className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "sidebar.expand" })} title={intl.formatMessage({ id: "sidebar.expand" })} aria-expanded={false} onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={18} /></button>
						</div>
						<div className="min-h-0 flex-1" />
						<div className="sidebar-settings-footer sidebar-settings-footer-collapsed">
							<button className="grid h-9 w-9 place-items-center rounded-xl text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "sidebar.openSettings" })} title={intl.formatMessage({ id: "sidebar.settings" })} onClick={openSettings}><Settings size={17} /></button>
						</div>
					</>
				) : (
					<>
						<div className="sidebar-brand-header flex shrink-0 items-center gap-2 border-b border-[var(--line-soft)] px-4">
							<div className="min-w-0 flex-1"><p className="truncate text-[14px] font-semibold tracking-[-0.01em]">Gori</p></div>
							<button className="sidebar-desktop-collapse rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "sidebar.collapse" })} title={intl.formatMessage({ id: "sidebar.collapse" })} aria-expanded={true} onClick={() => setSidebarCollapsed(true)}><PanelLeftClose size={17} /></button>
							{!homePage ? <button ref={mobileCloseRef} type="button" className="mobile-sidebar-close" aria-label={intl.formatMessage({ id: "sidebar.collapse" })} onClick={() => setMobileOpen(false)}><X size={18} /></button> : null}
						</div>

						<div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-4">
							<div className="mb-3 flex items-center justify-between px-1">
								<span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">{intl.formatMessage({ id: "sidebar.workspaces" })}</span>
								<button className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "sidebar.workspace.create" })} onClick={() => setWorkspaceDialogOpen(true)}><CirclePlus size={16} /></button>
							</div>
							{error ? <div className="mb-3 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-2.5 text-[12px] leading-5 text-[var(--danger)]"><p>{localizedErrorMessage(error)}</p><button className="mt-1 font-semibold underline" onClick={() => void refresh()}>{intl.formatMessage({ id: "common.reload" })}</button></div> : null}
							{mutationError ? <button className="mb-3 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-2.5 text-left text-[12px] leading-5 text-[var(--danger)]" onClick={() => setMutationError(null)}>{mutationError}</button> : null}
							{loading && tree === null ? <p className="px-2 py-4 text-[12px] text-[var(--text-muted)]">{intl.formatMessage({ id: "workspace.loading" })}</p> : null}
							<div className="app-scrollbar min-h-0 space-y-1 overflow-y-auto">
								{tree?.workspaces.map(({ workspace, sessions }) => {
									const activeWorkspace = activeWorkspaceId === workspace.id;
									const expanded = workspaceExpansion[workspace.id] ?? activeWorkspace;
									const sessionListId = `${workspace.id}-sessions`;

									return (
										<section key={workspace.id} className="py-0.5">
											<div data-active={activeWorkspace ? "true" : "false"} className={`sidebar-workspace-row flex items-center gap-0.5 rounded-lg transition ${activeWorkspace ? "bg-[var(--surface-selected)] text-[var(--ink)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"}`}>
											<button type="button" className="ml-1 grid h-8 w-6 shrink-0 place-items-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" onClick={() => setWorkspaceExpanded(workspace.id, !expanded)} aria-label={intl.formatMessage({ id: expanded ? "sidebar.workspace.sessions.collapse" : "sidebar.workspace.sessions.expand" }, { name: workspace.displayName })} aria-expanded={expanded} aria-controls={sessionListId}>
													<ChevronRight size={13} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
												</button>
											<Link href={`/workspaces/${workspace.id}/chat/new`} className="group flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-1 text-left" aria-label={intl.formatMessage({ id: "sidebar.workspace.newSession" }, { name: workspace.displayName })} onClick={(event) => { if (transferManager && !transferManager.confirmNavigation()) event.preventDefault(); }}>
													<Server size={14} aria-hidden="true" className={`shrink-0 ${activeWorkspace ? "text-[var(--accent-ink)]" : "text-[var(--text-muted)]"}`} />
											<div className="min-w-0 flex-1"><span className="sidebar-workspace-name block truncate text-[13px] font-medium">{workspace.displayName}</span><p className="sidebar-workspace-address truncate pt-0.5 font-mono text-[11px] text-[var(--text-muted)]">{workspace.host.hostname}:{workspace.host.port}</p></div>
													<span className="sidebar-workspace-count shrink-0 rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">{sessions.length}</span>
											</Link>
											<Link href={`/workspaces/${workspace.id}`} className="rounded-lg p-2 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "workspace.console.open" }, { name: workspace.displayName })} title={intl.formatMessage({ id: "workspace.console" })} onClick={(event) => { if (transferManager && !transferManager.confirmNavigation()) event.preventDefault(); }}><Settings2 size={14} /></Link>
											</div>

											{expanded ? (
												<div id={sessionListId} className="sidebar-session-list mb-2 ml-[27px] mr-2 mt-1.5">
													<div className="space-y-0.5">
														{sessions.map((session) => {
															const activeSession = activeSessionId === session.id;
															return (
																<div key={session.id} data-active={activeSession ? "true" : "false"} className={`sidebar-session-row group flex min-h-8 w-full items-center overflow-hidden rounded-lg transition ${activeSession ? "bg-[var(--surface-selected)] text-[var(--accent-ink)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"}`}>
																	<Link href={`/sessions/${session.id}`} aria-current={activeSession ? "page" : undefined} className="flex min-w-0 flex-1 self-stretch items-center px-2.5 py-1.5" onClick={() => setMobileOpen(false)}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeSession ? "bg-[var(--accent)]" : "bg-[var(--line-strong)]"}`} /><span className="ml-2 min-w-0 flex-1 truncate text-[12px] font-medium">{session.displayName}</span></Link>
																	<button className="sidebar-session-action rounded p-1.5 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`${intl.formatMessage({ id: "session.edit" })} ${session.displayName}`} onClick={() => setEditSession(session)}><Pencil size={13} /></button>
																	<button className="sidebar-session-action mr-1 rounded p-1.5 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--surface-hover)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={intl.formatMessage({ id: "sidebar.session.delete" }, { name: session.displayName })} onClick={() => { setDeleteSessionError(null); setDeleteSession(session); }}><Trash2 size={13} /></button>
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

						<div className="sidebar-settings-footer border-t border-[var(--line)]"><button className="grid h-9 w-9 place-items-center rounded-xl text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]" aria-label={intl.formatMessage({ id: "sidebar.openSettings" })} title={intl.formatMessage({ id: "sidebar.settings" })} onClick={openSettings}><Settings size={17} /></button></div>
					</>
				)}
			</aside>
			{workspaceDialogOpen ? <WorkspaceDialog onClose={() => setWorkspaceDialogOpen(false)} onCreated={(workspace) => { setWorkspaceDialogOpen(false); void refresh(); if (!transferManager || transferManager.confirmNavigation()) router.push(`/workspaces/${workspace.id}`); }} /> : null}
			{editSession && editedWorkspace ? <SessionEditDialog key={editSession.id} sessionId={editSession.id} workspace={editedWorkspace} onClose={() => setEditSession(null)} onUpdated={refreshEditedSession} /> : null}
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
