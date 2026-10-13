"use client";

import { useId, useRef, type KeyboardEvent } from "react";
import { FolderOpen, Gauge, KeyRound, ShieldCheck } from "lucide-react";
import { useIntl } from "react-intl";
import type { MessageId } from "@/features/i18n/messages/zh-CN";

const tabs: readonly { id: WorkspaceTab; labelId: MessageId; icon: typeof Gauge }[] = [
	{ id: "overview", labelId: "workspace.tabs.overview", icon: Gauge },
	{ id: "guard", labelId: "workspace.tabs.guard", icon: ShieldCheck },
	{ id: "credentials", labelId: "workspace.tabs.credentials", icon: KeyRound },
	{ id: "files", labelId: "workspace.tabs.files", icon: FolderOpen },
];

export type WorkspaceTab = "overview" | "guard" | "credentials" | "files";

export function useWorkspaceTabIds() {
	const id = useId();
	return { tabId: (tab: WorkspaceTab) => `${id}-${tab}`, panelId: `${id}-panel` };
}

interface WorkspaceTabNavigationProps {
	activeTab: WorkspaceTab;
	onChange(tab: WorkspaceTab): void;
	tabId(tab: WorkspaceTab): string;
	panelId: string;
}

export function WorkspaceTabNavigation({ activeTab, onChange, tabId, panelId }: WorkspaceTabNavigationProps) {
	const intl = useIntl();
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length
			: event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
			: event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
		if (nextIndex === undefined) return;
		event.preventDefault();
		onChange(tabs[nextIndex].id);
		buttons.current[nextIndex]?.focus();
	};
	return (
		<div className="page-tabs app-scrollbar" role="tablist" aria-label={intl.formatMessage({ id: "workspace.pages" })}>
			{tabs.map((tab, index) => {
				const Icon = tab.icon;
				return (
					<button
						key={tab.id}
						ref={(element) => { buttons.current[index] = element; }}
						type="button"
						role="tab"
						id={tabId(tab.id)}
						aria-controls={panelId}
						aria-selected={activeTab === tab.id}
						tabIndex={activeTab === tab.id ? 0 : -1}
						className="page-tab"
						onClick={() => onChange(tab.id)}
						onKeyDown={(event) => moveFocus(event, index)}
					>
						<Icon size={14} aria-hidden="true" />{intl.formatMessage({ id: tab.labelId })}
					</button>
				);
			})}
		</div>
	);
}
