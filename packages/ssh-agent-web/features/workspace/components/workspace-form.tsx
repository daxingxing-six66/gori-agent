"use client";

import { ArrowUpRight, Check, ChevronDown, KeyRound, Monitor, Plus, Server, Settings2 } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useIntl } from "react-intl";
import type { CreateCredentialInput } from "@/features/credential/model/credential";
import "./workspace-form.css";

export function WorkspaceFormSection({ title, description, children }: {
	title: string;
	description: ReactNode;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section className="workspace-form-section" aria-labelledby={headingId}>
			<div className="workspace-form-section-heading">
				<h3 id={headingId}>{title}</h3>
				<p>{description}</p>
			</div>
			<div className="workspace-form-section-content">{children}</div>
		</section>
	);
}

export function WorkspaceDirectoryField({ kind, label, path, hint, actionLabel, disabled, disabledReason, error, onChoose }: {
	kind: "local" | "remote";
	label: string;
	path: string;
	hint: string;
	actionLabel: string;
	disabled: boolean;
	disabledReason?: string;
	error?: string;
	onChoose(): void;
}) {
	const intl = useIntl();
	const hintId = useId();
	const Icon = kind === "local" ? Monitor : Server;
	return (
		<div className="workspace-directory-field">
			<span className="workspace-directory-label">{label}</span>
			<button type="button" className="workspace-directory-control" disabled={disabled} aria-label={actionLabel}
				aria-describedby={hintId} aria-invalid={Boolean(error && !disabledReason)} onClick={onChoose}>
				<span className="workspace-directory-icon" aria-hidden="true"><Icon size={14} strokeWidth={1.7} /></span>
				<span className="workspace-directory-value" title={path}>{path}</span>
				<span className="workspace-directory-action">{intl.formatMessage({ id: "workspace.directory.browse" })}<ArrowUpRight size={13} aria-hidden="true" /></span>
			</button>
			<p id={hintId} className={`workspace-field-hint${error && !disabledReason ? " workspace-field-error" : ""}`} role={error && !disabledReason ? "alert" : undefined}>
				{disabledReason ?? error ?? hint}
			</p>
		</div>
	);
}

export function WorkspaceCredentialField({ credential, configured, error, disabled, onConfigure }: {
	credential: Pick<CreateCredentialInput, "displayName" | "remoteUser" | "type"> | null;
	configured: boolean;
	error?: string;
	disabled: boolean;
	onConfigure(): void;
}) {
	const intl = useIntl();
	const hintId = useId();
	const description = configured && credential
		? `${credential.remoteUser} · ${intl.formatMessage({ id: credential.type === "private_key" ? "workspace.credential.privateKey" : "workspace.credential.password" })}`
		: intl.formatMessage({ id: credential ? "workspace.credential.reenterHint" : "workspace.credential.addHint" });
	return (
		<div>
			<button type="button" className="workspace-credential-control" disabled={disabled}
				aria-label={intl.formatMessage({ id: credential ? "workspace.credential.reconfigure" : "workspace.credential.configure" })}
				aria-describedby={hintId} aria-invalid={Boolean(error)} onClick={onConfigure}>
				<span className="workspace-credential-icon" aria-hidden="true"><KeyRound size={14} strokeWidth={1.7} /></span>
				<span className="workspace-credential-name" title={credential?.displayName}>{credential?.displayName ?? intl.formatMessage({ id: "workspace.credential.add" })}</span>
				<span className="workspace-credential-action">
					{configured ? <Check size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
					{intl.formatMessage({ id: configured ? "common.edit" : "workspace.credential.configure" })}
				</span>
			</button>
			<p id={hintId} className={`workspace-field-hint${error ? " workspace-field-error" : ""}`} role={error ? "alert" : undefined}>{error ?? description}</p>
		</div>
	);
}

export function WorkspaceConnectionOptions({ hasError, children }: { hasError: boolean; children: ReactNode }) {
	const intl = useIntl();
	return (
		<details className="workspace-connection-options" open={hasError || undefined} onInvalidCapture={(event) => { event.currentTarget.open = true; }}>
			<summary>
				<Settings2 size={15} aria-hidden="true" />
				<span>{intl.formatMessage({ id: "workspace.connection.advanced" })}</span>
				<span className="workspace-connection-options-hint">{intl.formatMessage({ id: "workspace.connection.advancedHint" })}</span>
				<ChevronDown size={15} className="workspace-connection-options-chevron" aria-hidden="true" />
			</summary>
			<div className="workspace-connection-options-content">{children}</div>
		</details>
	);
}
