"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Folder, LoaderCircle } from "lucide-react";
import { LocalDirectoryPicker } from "@/features/session/components/local-directory-picker";
import { NoticeCard } from "@/components/notice-card";
import { canTestConnection, ConnectionTestController } from "../runtime/connection-test-controller";
import { useIntl } from "react-intl";
import {
	DialogError,
	DialogField,
	ManagementDialog,
	dialogInputClass,
} from "@/components/management-dialog";
import { CustomSelect } from "@/components/custom-select";
import { CredentialDialog } from "@/features/credential/components/credential-dialog";
import type { CreateCredentialInput } from "@/features/credential/model/credential";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { workspaceApi } from "@/features/workspace/api/workspace-api";
import {
	DEFAULT_WORKSPACE_CWD,
	type Workspace,
	type WorkspaceEnvironment,
} from "@/features/workspace/model/workspace";
import { isAbsoluteRemotePath } from "@/features/sftp/model/sftp-state";
import { ApiError } from "@/shared/errors/api-error";

function validationError(error: ApiError | null, field: string): string | undefined {
	if (error?.code !== "validation_error") return undefined;
	const errorField = error.field?.replace(/^body\./, "");
	return errorField === field ? error.message : undefined;
}

function hasCredentialSecret(credential: CreateCredentialInput | null): credential is CreateCredentialInput {
	if (credential === null) return false;
	return credential.type === "private_key" ? credential.privateKey.length > 0 : credential.password.length > 0;
}

function clearCredentialSecrets(credential: CreateCredentialInput): CreateCredentialInput {
	return credential.type === "private_key"
		? { ...credential, privateKey: "", passphrase: undefined }
		: { ...credential, password: "" };
}

export function WorkspaceDialog({ onClose, onCreated }: {
	onClose(): void;
	onCreated(workspace: Workspace): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [creatingCredential, setCreatingCredential] = useState(false);
	const [credential, setCredential] = useState<CreateCredentialInput | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [environment, setEnvironment] = useState<WorkspaceEnvironment>("development");
	const [hostname, setHostname] = useState("");
	const [port, setPort] = useState("22");
	const [defaultCwd, setDefaultCwd] = useState(DEFAULT_WORKSPACE_CWD);
	const [remoteDefaultCwd, setRemoteDefaultCwd] = useState("/");
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
	const [connectTimeoutMs, setConnectTimeoutMs] = useState("10000");
	const [keepaliveIntervalMs, setKeepaliveIntervalMs] = useState("15000");
	const [keepaliveMaxCount, setKeepaliveMaxCount] = useState("3");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<ApiError | null>(null);
	const [connectionTest] = useState(() => new ConnectionTestController(workspaceApi.testConnection));
	const testState = useSyncExternalStore(connectionTest.subscribe, connectionTest.getSnapshot, connectionTest.getSnapshot);
	useEffect(() => () => connectionTest.reset(), [connectionTest]);
	const testInput = credential === null ? null : {
		host: { hostname, port: port.trim() ? Number(port) : Number.NaN }, credential,
		connection: {
			connectTimeoutMs: connectTimeoutMs.trim() ? Number(connectTimeoutMs) : Number.NaN,
			keepaliveIntervalMs: keepaliveIntervalMs.trim() ? Number(keepaliveIntervalMs) : Number.NaN,
			keepaliveMaxCount: keepaliveMaxCount.trim() ? Number(keepaliveMaxCount) : Number.NaN,
		},
	};
	const testEnabled = canTestConnection(testInput);
	const testing = testState.status === "testing";
	const close = () => { connectionTest.reset(); onClose(); };
	const configureCredential = () => { connectionTest.reset(); setCreatingCredential(true); };
	const remoteCwdError = !isAbsoluteRemotePath(remoteDefaultCwd) ? intl.formatMessage({ id: "workspace.remoteDefaultCwd.invalid" }) : undefined;

	if (directoryPickerOpen) {
		return <LocalDirectoryPicker
			initialPath={defaultCwd}
			onClose={() => setDirectoryPickerOpen(false)}
			onSelect={(path) => { setDefaultCwd(path); setDirectoryPickerOpen(false); }}
		/>;
	}

	if (creatingCredential) {
		return <CredentialDialog
			mode="draft"
			initialValue={credential ?? undefined}
			onClose={() => setCreatingCredential(false)}
			onSubmitted={(input) => {
				connectionTest.reset();
				setCredential(input);
				setError(null);
				setCreatingCredential(false);
			}}
		/>;
	}

	return <ManagementDialog
		title={intl.formatMessage({ id: "workspace.create" })}
		description={intl.formatMessage({ id: "workspace.create.description" })}
		onClose={close}
		submitLabel={intl.formatMessage({ id: "workspace.create" })}
		submitting={submitting}
		submitDisabled={testing || !hasCredentialSecret(credential) || remoteCwdError !== undefined}
		footerLeading={<span title={!testEnabled ? intl.formatMessage({ id: "workspace.testConnection.required" }) : undefined}>
			<button type="button" className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--line)] px-4 text-[10px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-50" disabled={!testEnabled || testing || submitting} aria-describedby={!testEnabled ? "connection-test-requirements" : undefined} aria-busy={testing} onClick={() => { if (testInput) void connectionTest.run(testInput); }}>
				{testing ? <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : null}
				{intl.formatMessage({ id: testing ? "workspace.testConnection.loading" : "workspace.testConnection.button" })}
			</button>
			{!testEnabled ? <span id="connection-test-requirements" className="sr-only">{intl.formatMessage({ id: "workspace.testConnection.required" })}</span> : null}
		</span>}
		footerNotice={testState.status === "success" ? <NoticeCard tone="info" message={intl.formatMessage({ id: "workspace.testConnection.success" })} /> : testState.status === "error" ? <NoticeCard tone="error" message={localizedErrorMessage(testState.error)} /> : undefined}
		onSubmit={(event) => {
			event.preventDefault();
			if (connectionTest.getSnapshot().status === "testing" || submitting || !hasCredentialSecret(credential) || remoteCwdError !== undefined) return;
			connectionTest.reset();
			setSubmitting(true);
			setError(null);
			void workspaceApi.create({
				displayName,
				environment,
				host: {
					hostname,
					port: Number(port),
				},
				credential,
				defaultCwd,
				remoteDefaultCwd,
				connection: {
					connectTimeoutMs: Number(connectTimeoutMs),
					keepaliveIntervalMs: Number(keepaliveIntervalMs),
					keepaliveMaxCount: Number(keepaliveMaxCount),
				},
			}).then(({ workspace }) => onCreated(workspace)).catch((requestError: unknown) => {
				setError(
					requestError instanceof ApiError
						? requestError
						: new ApiError(0, "network_error", localizedErrorMessage(requestError)),
				);
			}).finally(() => {
				setCredential((current) => current === null ? null : clearCredentialSecrets(current));
				setSubmitting(false);
			});
		}}
	>
		<DialogError message={error ? localizedErrorMessage(error) : null} />
		<div className="grid gap-4 sm:grid-cols-2">
			<DialogField label={intl.formatMessage({ id: "workspace.field.displayName" })} error={validationError(error, "displayName")}><input className={dialogInputClass} required autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></DialogField>
			<DialogField label={intl.formatMessage({ id: "workspace.field.environment" })} error={validationError(error, "environment")}><CustomSelect ariaLabel={intl.formatMessage({ id: "workspace.field.environment" })} value={environment} onChange={(value) => setEnvironment(value as WorkspaceEnvironment)} options={[{ value: "production", label: intl.formatMessage({ id: "workspace.environment.production" }) }, { value: "staging", label: intl.formatMessage({ id: "workspace.environment.staging" }) }, { value: "development", label: intl.formatMessage({ id: "workspace.environment.development" }) }, { value: "other", label: intl.formatMessage({ id: "workspace.environment.other" }) }]} /></DialogField>
			<DialogField label={intl.formatMessage({ id: "workspace.field.hostname" })} error={validationError(error, "host.hostname")}><input className={dialogInputClass} required value={hostname} onChange={(event) => { connectionTest.reset(); setHostname(event.target.value); }} /></DialogField>
			<DialogField label={intl.formatMessage({ id: "workspace.field.port" })} error={validationError(error, "host.port")}><input className={dialogInputClass} required type="number" min="1" max="65535" value={port} onChange={(event) => { connectionTest.reset(); setPort(event.target.value); }} /></DialogField>
		</div>
		<div className="block">
			<div className="mb-1.5 flex items-center text-[9px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
				<span>{intl.formatMessage({ id: "workspace.field.firstCredential" })}</span>
				<button type="button" className="font-normal text-[#397b5c] transition-colors hover:text-[#2d674c]" onClick={configureCredential}>（{intl.formatMessage({ id: credential ? "workspace.credential.reconfigure" : "workspace.credential.configure" })}）</button>
			</div>
			{credential ? <button type="button" className="flex w-full items-center justify-between rounded-lg border border-[var(--line)] bg-white px-3 py-2.5 text-left" onClick={configureCredential}><span><span className="block text-[11px] font-medium text-zinc-800">{credential.displayName}</span><span className="mt-0.5 block text-[9px] text-zinc-400">{credential.remoteUser} · {intl.formatMessage({ id: credential.type === "private_key" ? "workspace.credential.privateKey" : "workspace.credential.password" })}</span></span><span className="text-[9px] text-[#397b5c]">{intl.formatMessage({ id: "common.edit" })}</span></button> : <button type="button" className="w-full rounded-lg border border-dashed border-[#9bb9a8] bg-[#f5f8f5] px-3 py-3 text-left text-[10px] text-[#397b5c]" onClick={configureCredential}>{intl.formatMessage({ id: "workspace.credential.required" })}</button>}
			{error?.code === "validation_error" && error.field?.replace(/^body\./, "").startsWith("credential.") ? <p className="mt-1 text-[9px] leading-4 text-rose-600" role="alert">{error.message}</p> : null}
		</div>
		<DialogField label={intl.formatMessage({ id: "workspace.field.defaultCwd" })} hint={intl.formatMessage({ id: "session.workDir.description" })} error={validationError(error, "defaultCwd")}>
			<button type="button" className={`${dialogInputClass} flex items-center gap-2 text-left disabled:opacity-50`} disabled={submitting} aria-label={intl.formatMessage({ id: "session.workDir.chooseLabel" })} onClick={() => setDirectoryPickerOpen(true)}>
				<Folder size={15} className="shrink-0 text-zinc-400" />
				<span className="min-w-0 flex-1 truncate font-mono" title={defaultCwd}>{defaultCwd}</span>
				<span className="shrink-0 text-[10px] text-[#397b5c]">{intl.formatMessage({ id: "session.workDir.chooseLabel" })}</span>
			</button>
		</DialogField>
		<DialogField label={intl.formatMessage({ id: "workspace.field.remoteDefaultCwd" })} hint={intl.formatMessage({ id: "workspace.remoteDefaultCwd.description" })} error={remoteCwdError ?? validationError(error, "remoteDefaultCwd")}>
			<input className={dialogInputClass} aria-label={intl.formatMessage({ id: "workspace.field.remoteDefaultCwd" })} required pattern="/.*" value={remoteDefaultCwd} disabled={submitting} onChange={(event) => setRemoteDefaultCwd(event.target.value)} />
		</DialogField>
		<div className="grid gap-4 sm:grid-cols-3">
			<DialogField label={intl.formatMessage({ id: "workspace.field.connectTimeout" })} error={validationError(error, "connection.connectTimeoutMs")}><input className={dialogInputClass} required type="number" min="1" value={connectTimeoutMs} onChange={(event) => { connectionTest.reset(); setConnectTimeoutMs(event.target.value); }} /></DialogField>
			<DialogField label={intl.formatMessage({ id: "workspace.field.keepaliveInterval" })} error={validationError(error, "connection.keepaliveIntervalMs")}><input className={dialogInputClass} required type="number" min="1" value={keepaliveIntervalMs} onChange={(event) => { connectionTest.reset(); setKeepaliveIntervalMs(event.target.value); }} /></DialogField>
			<DialogField label={intl.formatMessage({ id: "workspace.field.keepaliveMaxCount" })} error={validationError(error, "connection.keepaliveMaxCount")}><input className={dialogInputClass} required type="number" min="1" value={keepaliveMaxCount} onChange={(event) => { connectionTest.reset(); setKeepaliveMaxCount(event.target.value); }} /></DialogField>
		</div>
	</ManagementDialog>;
}
