"use client";

import { Folder, Plus, X } from "lucide-react";
import { useId } from "react";
import { useIntl } from "react-intl";
import "./sandbox-writable-roots.css";

/** Shared compact directory list; browsing and persistence belong to the containing dialog. */
export function SandboxWritableRootsField({ roots, hint, disabled, error, onChoose, onChange }: {
	roots: string[];
	hint: string;
	disabled: boolean;
	error?: string;
	onChoose(): void;
	onChange(roots: string[]): void;
}) {
	const intl = useIntl();
	const hintId = useId();
	return (
		<div className="sandbox-roots-field" role="group" aria-label={intl.formatMessage({ id: "sandbox.roots.title" })} aria-describedby={hintId}>
			<div className="sandbox-roots-heading">
				<span>{intl.formatMessage({ id: "sandbox.roots.title" })}</span>
				<button type="button" disabled={disabled} onClick={onChoose}>
					<Plus size={12} aria-hidden="true" />{intl.formatMessage({ id: "sandbox.roots.choose" })}
				</button>
			</div>
			{roots.length > 0 ? <ul className="sandbox-roots-list">
				{roots.map((root) => <li key={root}>
					<Folder size={13} aria-hidden="true" />
					<span title={root}>{root}</span>
					<button type="button" disabled={disabled} aria-label={intl.formatMessage({ id: "sandbox.roots.remove" }, { path: root })}
						onClick={() => onChange(roots.filter((entry) => entry !== root))}><X size={12} aria-hidden="true" /></button>
				</li>)}
			</ul> : <p className="sandbox-roots-empty">{intl.formatMessage({ id: "sandbox.roots.empty" })}</p>}
			<p id={hintId} className={error ? "sandbox-roots-error" : "sandbox-roots-hint"} role={error ? "alert" : undefined}>{error ?? hint}</p>
		</div>
	);
}
