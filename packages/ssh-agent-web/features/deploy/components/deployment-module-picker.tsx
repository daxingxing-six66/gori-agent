"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Package } from "lucide-react";
import { useIntl } from "react-intl";
import type { DeploymentProfileSummary } from "../model/deployment";

export interface DeploymentModuleOption {
	key: string;
	file: string;
	moduleId: string;
	moduleName: string;
	project: string;
}

export function deploymentModuleOptions(profiles: readonly DeploymentProfileSummary[]): DeploymentModuleOption[] {
	return profiles.flatMap((profile) => profile.modules.map((module) => ({
		key: JSON.stringify([profile.file, module.id]),
		file: profile.file,
		moduleId: module.id,
		moduleName: module.name,
		project: profile.project,
	})));
}

export function DeploymentModulePicker({ profiles, busy, disabled = false, onSelect }: {
	profiles: readonly DeploymentProfileSummary[];
	busy: boolean;
	disabled?: boolean;
	onSelect(file: string, moduleId: string): void;
}) {
	const intl = useIntl();
	const options = useMemo(() => deploymentModuleOptions(profiles), [profiles]);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const selectionPendingRef = useRef(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const labelId = useId();
	const valueId = useId();
	const listId = useId();
	const selected = options.find((option) => option.key === selectedKey);
	useEffect(() => { if (!busy) selectionPendingRef.current = false; }, [busy]);

	useEffect(() => {
		if (!open) return;
		optionRefs.current[activeIndex]?.focus();
	}, [open, activeIndex]);
	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [open]);

	const openList = (fromEnd = false) => {
		if (busy || disabled || options.length === 0) return;
		setActiveIndex(fromEnd ? options.length - 1 : Math.max(options.findIndex((option) => option.key === selectedKey), 0));
		setOpen(true);
	};
	const closeList = (restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	};
	const choose = (option: DeploymentModuleOption) => {
		if (busy || disabled || selectionPendingRef.current) return;
		selectionPendingRef.current = true;
		setSelectedKey(option.key);
		closeList(true);
		onSelect(option.file, option.moduleId);
	};
	const onListKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeList(true);
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((index) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
		}
	};

	return <div aria-busy={busy}>
		<div ref={rootRef} className="relative max-w-xl" onBlur={(event) => {
			if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
		}}>
			<span id={labelId} className="mb-2 block text-xs font-medium text-secondary">{intl.formatMessage({ id: "deploy.module" })}</span>
			<button ref={triggerRef} type="button" disabled={busy || disabled || options.length === 0} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
				aria-labelledby={`${labelId} ${valueId}`}
				onClick={() => open ? closeList() : openList()}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						openList(event.key === "ArrowUp");
					}
				}}
				className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-line bg-surface-raised px-3.5 py-3 text-left shadow-[var(--shadow-soft)] transition-colors hover:border-line-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50">
				<span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--success-soft)] text-accent"><Package size={18} aria-hidden="true" /></span>
				<span id={valueId} className="min-w-0 flex-1">
					{selected ? <><span className="block truncate text-sm font-semibold text-ink">{selected.moduleName} <span className="font-normal text-muted">({selected.moduleId})</span></span>
						<span className="mt-0.5 block truncate text-xs text-muted" title={`${selected.project} · ${selected.file}`}>{selected.project} · {selected.file}</span></>
						: <span className="block text-sm text-muted">{intl.formatMessage({ id: "deploy.module.placeholder" })}</span>}
				</span>
				<ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
			</button>
			{open ? <div id={listId} role="listbox" aria-labelledby={labelId} onKeyDown={onListKeyDown}
				className="app-scrollbar absolute inset-x-0 top-[calc(100%+8px)] z-20 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface-raised p-1.5 shadow-[var(--shadow-soft)]">
				{options.map((option, index) => <button key={option.key} ref={(node) => { optionRefs.current[index] = node; }} type="button" role="option"
					aria-selected={option.key === selected?.key}
					aria-label={`${option.moduleName} (${option.moduleId}) · ${option.project} · ${option.file}`}
					tabIndex={index === activeIndex ? 0 : -1}
					onClick={() => choose(option)}
					className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
					<span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{option.moduleName} <span className="font-normal text-muted">({option.moduleId})</span></span>
						<span className="mt-0.5 block truncate text-[11px] text-muted" title={`${option.project} · ${option.file}`}>{option.project} · {intl.formatMessage({ id: "deploy.module.profile" }, { profile: option.file })}</span></span>
					{option.key === selected?.key ? <Check size={16} className="shrink-0 text-accent" aria-hidden="true" /> : null}
				</button>)}
			</div> : null}
		</div>
	</div>;
}
