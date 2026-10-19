"use client";

import Link from "next/link";
import { Pencil, Trash2 } from "lucide-react";
import { useIntl } from "react-intl";
import { SessionActivityIndicator } from "@/features/session-activity/components/session-activity-indicator";
import { useAcknowledgeSessionActivity } from "@/features/session-activity/components/session-activity-provider";
import type { Session } from "@/features/session/model/session";
import "./sidebar-session-row.css";

interface SidebarSessionRowProps {
	session: Session;
	active: boolean;
	onNavigate(): void;
	onEdit(session: Session): void;
	onDelete(session: Session): void;
}

/** Owns the row's presentation and action priority, without controlling the Agent lifecycle. */
export function SidebarSessionRow({ session, active, onNavigate, onEdit, onDelete }: SidebarSessionRowProps) {
	const intl = useIntl();
	const acknowledge = useAcknowledgeSessionActivity(session.id);
	return (
		<div className="sidebar-session-row" data-active={active}>
			<Link href={`/sessions/${session.id}`} aria-current={active ? "page" : undefined} className="sidebar-session-link" onClick={(event) => {
				if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
				acknowledge();
				onNavigate();
			}}>
				<span className="sidebar-session-marker" aria-hidden="true" />
				<span className="sidebar-session-name">{session.displayName}</span>
			</Link>
			<div className="sidebar-session-trailing">
				<div className="sidebar-session-status"><SessionActivityIndicator sessionId={session.id} /></div>
				<div className="sidebar-session-actions">
					<button type="button" className="sidebar-session-action" aria-label={`${intl.formatMessage({ id: "session.edit" })} ${session.displayName}`} onClick={() => onEdit(session)}><Pencil size={13} /></button>
					<button type="button" className="sidebar-session-action sidebar-session-delete" aria-label={intl.formatMessage({ id: "sidebar.session.delete" }, { name: session.displayName })} onClick={() => onDelete(session)}><Trash2 size={13} /></button>
				</div>
			</div>
		</div>
	);
}
