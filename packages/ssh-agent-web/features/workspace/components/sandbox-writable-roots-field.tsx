"use client";

import { Folder, Plus, X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useIntl } from "react-intl";
import "./sandbox-writable-roots.css";

/** Shared compact directory list; browsing and persistence belong to the containing dialog. */
export function SandboxWritableRootsField({ roots, hint, disabled, error, settings, headingAction, masked = false, onChoose, onChange }: {
	roots: string[];
	hint?: string;
	disabled: boolean;
	error?: string;
	settings?: ReactNode;
	headingAction?: ReactNode;
	masked?: boolean;
	onChoose(): void;
	onChange(roots: string[]): void;
}) {
	const intl = useIntl();
	const hintId = useId();
	const choose = <button type="button" disabled={disabled} onClick={onChoose}>
		<Plus size={12} aria-hidden="true" />{intl.formatMessage({ id: "sandbox.roots.choose" })}
	</button>;
	return (
		<div className="sandbox-roots-field" role="group" aria-label={intl.formatMessage({ id: "sandbox.roots.title" })} aria-describedby={error || hint ? hintId : undefined}>
			<div className="sandbox-roots-heading">
				<div className="sandbox-roots-title">
					<span>{intl.formatMessage({ id: "sandbox.roots.title" })}</span>
					{settings}
				</div>
				{headingAction ?? (settings ? null : choose)}
			</div>
			<div className="sandbox-roots-selection" aria-disabled={masked || undefined}>
				{settings ? <div className="sandbox-roots-choose">{choose}</div> : null}
				{roots.length > 0 ? <ul className="sandbox-roots-list">
					{roots.map((root) => <li key={root}>
						<Folder size={13} aria-hidden="true" />
						<span title={root}>{root}</span>
						<button type="button" disabled={disabled} aria-label={intl.formatMessage({ id: "sandbox.roots.remove" }, { path: root })}
							onClick={() => onChange(roots.filter((entry) => entry !== root))}><X size={12} aria-hidden="true" /></button>
					</li>)}
				</ul> : <p className="sandbox-roots-empty">{intl.formatMessage({ id: "sandbox.roots.empty" })}</p>}
				{error || hint ? <p id={hintId} className={error ? "sandbox-roots-error" : "sandbox-roots-hint"} role={error ? "alert" : undefined}>{error ?? hint}</p> : null}
				{masked ? <div className="sandbox-roots-overlay" aria-hidden="true" /> : null}
			</div>
		</div>
	);
}
