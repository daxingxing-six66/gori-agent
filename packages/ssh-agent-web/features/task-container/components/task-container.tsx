"use client";

import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { TaskContainerDisplayMode } from "../model/task-container-display";
import { activateTaskContainerFullscreen } from "../runtime/task-container-fullscreen";
import "./task-container.css";

export interface TaskTabStatus {
	label: string;
	tone: "neutral" | "positive" | "warning" | "danger";
}

export interface TaskTabClose {
	label: string;
	disabled?: boolean;
	disabledReason?: string;
	busy?: boolean;
	onRequestClose(): void;
}

export interface TaskTab {
	id: string;
	title: string;
	content: ReactNode;
	status?: TaskTabStatus;
	close?: TaskTabClose;
}

export interface TaskContainerProps {
	tabs: readonly TaskTab[];
	activeTabId: string | null;
	tabListLabel: string;
	onSelect(id: string): void;
	display?: {
		mode: TaskContainerDisplayMode;
		fullscreenLabel: string;
		exitFullscreenLabel: string;
		collapseLabel: string;
		expandLabel: string;
		onModeChange(mode: TaskContainerDisplayMode): void;
	};
}

/** Presentation only: the caller owns task identity, selection and lifecycle. */
export function TaskContainer({ tabs, activeTabId, tabListLabel, onSelect, display }: TaskContainerProps) {
	const instanceId = useId();
	const containerRef = useRef<HTMLElement>(null);
	const fullscreenButton = useRef<HTMLButtonElement>(null);
	const expandButton = useRef<HTMLButtonElement>(null);
	const previousDisplay = useRef<TaskContainerDisplayMode>("docked");
	const tabButtons = useRef(new Map<string, HTMLButtonElement>());
	const selectedId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;
	const elementId = (tabId: string) => `${instanceId}-${encodeURIComponent(tabId)}`;
	const mode = display?.mode ?? "docked";
	const collapsed = mode === "collapsed";
	const fullscreen = mode === "fullscreen";
	const onModeChange = display?.onModeChange;
	const hasTabs = tabs.length > 0;
	useEffect(() => {
		if (!hasTabs) return;
		if (collapsed) expandButton.current?.focus();
		else if (previousDisplay.current === "collapsed") fullscreenButton.current?.focus();
		previousDisplay.current = mode;
	}, [collapsed, hasTabs, mode]);
	useEffect(() => {
		if (fullscreen && hasTabs && containerRef.current && onModeChange) {
			return activateTaskContainerFullscreen(containerRef.current, () => onModeChange("docked"));
		}
	}, [fullscreen, hasTabs, onModeChange]);

	function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		let nextIndex: number;
		switch (event.key) {
			case "ArrowRight": nextIndex = (index + 1) % tabs.length; break;
			case "ArrowLeft": nextIndex = (index - 1 + tabs.length) % tabs.length; break;
			case "Home": nextIndex = 0; break;
			case "End": nextIndex = tabs.length - 1; break;
			default: return;
		}
		const next = tabs[nextIndex];
		if (!next) return;
		event.preventDefault();
		onSelect(next.id);
		tabButtons.current.get(next.id)?.focus();
	}

	if (tabs.length === 0) return null;

	return <section ref={containerRef} className="task-container" data-display={mode} tabIndex={-1}
		role={fullscreen ? "region" : undefined} aria-label={fullscreen ? tabListLabel : undefined}>
		{display ? <button ref={expandButton} type="button" className="task-container-expand" hidden={!collapsed}
			aria-label={display.expandLabel} title={display.expandLabel} aria-expanded={false} aria-controls={`${instanceId}-content`}
			onClick={() => display.onModeChange("docked")}>
			<PanelRightOpen size={16} aria-hidden="true" />
			<span className="task-container-collapsed-title">{tabs.find((tab) => tab.id === selectedId)?.title}</span>
			{tabs.length > 1 ? <span className="task-container-collapsed-count">{tabs.length}</span> : null}
		</button> : null}
		<div className="ion-only ion-region-label ion-region-observer" hidden={collapsed} aria-hidden="true"><span>03 /</span><span>RUNTIME OBSERVATORY</span></div>
		<div className="task-container-header" hidden={collapsed}>
			<div className="task-container-tabs app-scrollbar" role="tablist" aria-label={tabListLabel}>
				{tabs.map((tab, index) => {
					const selected = tab.id === selectedId;
					const id = elementId(tab.id);
					const closeDisabled = Boolean(tab.close?.disabled || tab.close?.busy);
					const closeReason = closeDisabled ? tab.close?.disabledReason : undefined;
					return <div className="task-container-tab-item" data-selected={selected} role="presentation" key={tab.id}>
						<button type="button" className="task-container-tab" role="tab" id={`${id}-tab`}
							aria-selected={selected} aria-controls={`${id}-panel`} tabIndex={selected ? 0 : -1}
							onClick={() => onSelect(tab.id)} onKeyDown={(event) => navigate(event, index)}
							ref={(button) => {
								if (button) tabButtons.current.set(tab.id, button);
								else tabButtons.current.delete(tab.id);
							}}>
							{tab.status ? <span className={`task-container-status-dot task-container-status-${tab.status.tone}`} aria-hidden="true" /> : null}
							<span className="task-container-tab-title">{tab.title}</span>
							{tab.status ? <span className="task-container-tab-status">{tab.status.label}</span> : null}
						</button>
						{tab.close ? <button type="button" className="task-container-close" aria-label={tab.close.label}
							title={closeReason ?? tab.close.label} disabled={closeDisabled} aria-busy={tab.close.busy || undefined}
							aria-describedby={closeReason ? `${id}-close-reason` : undefined}
							onClick={() => { if (!closeDisabled) tab.close?.onRequestClose(); }}>
							<X size={13} strokeWidth={1.8} aria-hidden="true" />
						</button> : null}
						{closeReason ? <span className="task-container-sr-only" id={`${id}-close-reason`}>{closeReason}</span> : null}
					</div>;
				})}
			</div>
			{display ? <div className="task-container-display-controls">
				<button ref={fullscreenButton} data-task-fullscreen-toggle type="button" className="task-container-display-button"
					aria-label={fullscreen ? display.exitFullscreenLabel : display.fullscreenLabel}
					title={fullscreen ? display.exitFullscreenLabel : display.fullscreenLabel} aria-pressed={fullscreen}
					onClick={() => display.onModeChange(fullscreen ? "docked" : "fullscreen")}>
					{fullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
				</button>
				<button type="button" className="task-container-display-button" aria-label={display.collapseLabel} title={display.collapseLabel}
					aria-expanded={true} aria-controls={`${instanceId}-content`} onClick={() => display.onModeChange("collapsed")}>
					<PanelRightClose size={15} aria-hidden="true" />
				</button>
			</div> : null}
		</div>
		<div className="task-container-content" id={`${instanceId}-content`} hidden={collapsed}>
			{tabs.map((tab) => <div className="task-container-page" key={tab.id} role="tabpanel"
				id={`${elementId(tab.id)}-panel`} aria-labelledby={`${elementId(tab.id)}-tab`}
				hidden={tab.id !== selectedId} tabIndex={0}>
				{/* Switching views hides the page without unmounting its task runtime. */}
				{tab.content}
			</div>)}
		</div>
	</section>;
}
