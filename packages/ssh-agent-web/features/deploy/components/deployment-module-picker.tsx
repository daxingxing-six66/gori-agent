"use client";

import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { DeploymentDiscovery } from "../model/deployment";
import { deploymentModuleOptions, type DeploymentModuleOption } from "../model/deployment-module-options";
import "./deployment-module-picker.css";

/** Non-modal launcher above the Composer. It never renders or owns deployment execution. */
export function DeploymentModulePicker({ discovery, loading, busy, disabled, error, onSelect, onSetup, onClose, onRetry }: {
	discovery: DeploymentDiscovery | null; loading: boolean; busy: boolean; disabled: boolean; error: string | null;
	onSelect(file: string, moduleId: string): Promise<void>; onSetup(): void; onClose(restoreFocus?: boolean): void; onRetry(): void;
}) {
	const intl = useIntl();
	const titleId = useId();
	const root = useRef<HTMLDivElement>(null);
	const rows = useRef<(HTMLInputElement | null)[]>([]);
	const choosing = useRef(false);
	const [selected, setSelected] = useState<string | null>(null);
	const options = useMemo(() => deploymentModuleOptions(discovery?.profiles ?? []), [discovery?.profiles]);
	useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
	useEffect(() => {
		const closeOutside = (event: PointerEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) onClose(false);
		};
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [onClose]);
	const choose = async (option: DeploymentModuleOption) => {
		if (loading || busy || disabled || choosing.current) return;
		choosing.current = true;
		setSelected(option.key);
		try { await onSelect(option.file, option.moduleId); }
		finally { choosing.current = false; setSelected(null); }
	};
	return <div ref={root} className="deploy-module-popover" role="dialog" tabIndex={-1} aria-modal={false} aria-labelledby={titleId} aria-busy={loading || busy}
		onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); } }}>
		<header className="deploy-module-popover-header"><h2 id={titleId}>{intl.formatMessage({ id: "deploy.picker.title" })}</h2>
			<button type="button" onClick={() => onClose(true)} aria-label={intl.formatMessage({ id: "deploy.picker.close" })}><X size={16} /></button>
		</header>
		<div className="deploy-module-body app-scrollbar">
		{error ? <div className="deploy-module-feedback" role="alert"><span>{error}</span><button type="button" disabled={loading || busy} onClick={onRetry}>{intl.formatMessage({ id: "deploy.task.retry" })}</button></div> : null}
		{loading ? <p className="deploy-module-feedback" role="status">{intl.formatMessage({ id: "deploy.loading" })}</p> : <>
			{discovery?.errors.map((problem) => <p className="deploy-module-feedback" role="alert" key={problem.file}>{problem.file}: {problem.message}</p>)}
			{options.length === 0 && !error ? <p className="deploy-module-feedback">{intl.formatMessage({ id: "deploy.noProfile" })}</p> : null}
			<ol className="deploy-module-list" aria-label={intl.formatMessage({ id: "deploy.module" })}>
				{options.map((option, index) => <li key={option.key}><label className="deploy-module-card">
					<input type="radio" name={titleId} className="deploy-module-select" checked={selected === option.key} ref={(node) => { rows.current[index] = node; }} disabled={busy || disabled}
					onChange={(event) => { if (event.target.checked) void choose(option); }} onKeyDown={(event) => {
						const next = event.key === "ArrowDown" ? (index + 1) % options.length : event.key === "ArrowUp" ? (index + options.length - 1) % options.length
							: event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
						if (next !== null) { event.preventDefault(); rows.current[next]?.focus(); }
					}} aria-label={intl.formatMessage({ id: "deploy.picker.selectModule" }, { module: option.moduleName })} />
					<span className="deploy-module-number" aria-hidden="true">{index + 1}.</span>
					<span className="deploy-module-name" title={option.moduleName}>{option.moduleName}</span>
				</label></li>)}
			</ol>
		</>}
		</div>
		<footer><button type="button" disabled={loading || busy || disabled} onClick={onSetup}>{intl.formatMessage({ id: "deploy.task.addService" })}</button></footer>
	</div>;
}
