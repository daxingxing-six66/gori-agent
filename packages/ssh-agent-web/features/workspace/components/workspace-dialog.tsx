"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Cable, LoaderCircle, LockKeyhole, Server } from "lucide-react";
import { LocalDirectoryPicker } from "@/features/session/components/local-directory-picker";
import { RemoteDirectoryPicker } from "./remote-directory-picker";
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
import { ApiError } from "@/shared/errors/api-error";
import { validSandboxWritableRoots } from "../model/sandbox-writable-roots";
import { SandboxWritableRootsField } from "./sandbox-writable-roots-field";
import { WorkspaceConnectionOptions, WorkspaceCredentialField, WorkspaceDirectoryField, WorkspaceFormSection } from "./workspace-form";

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
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
	const [selectedSandboxRoots, setSelectedSandboxRoots] = useState<string[] | null>(null);
	const [sandboxPickerOpen, setSandboxPickerOpen] = useState(false);
	const sandboxWritableRoots = selectedSandboxRoots ?? [];
	const rootsError = !validSandboxWritableRoots(sandboxWritableRoots) ? intl.formatMessage({ id: "sandbox.roots.invalid" }) : undefined;
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
	const browseRemote = useCallback((path: string, signal: AbortSignal) => {
		if (credential === null) throw new Error("SSH credential is required");
		return workspaceApi.browseDirectory({
			host: { hostname, port: Number(port) }, credential,
			connection: { connectTimeoutMs: Number(connectTimeoutMs), keepaliveIntervalMs: Number(keepaliveIntervalMs), keepaliveMaxCount: Number(keepaliveMaxCount) },
		}, path, signal);
	}, [credential, hostname, port, connectTimeoutMs, keepaliveIntervalMs, keepaliveMaxCount]);

	if (directoryPickerOpen) {
		return <LocalDirectoryPicker
			initialPath={defaultCwd}
			onClose={() => setDirectoryPickerOpen(false)}
			onSelect={(path) => { setDefaultCwd(path); setDirectoryPickerOpen(false); }}
		/>;
	}

	if (sandboxPickerOpen) {
		return <RemoteDirectoryPicker initialPath={sandboxWritableRoots[0] ?? "/"} load={browseRemote}
			onClose={() => setSandboxPickerOpen(false)} multiple={{ initialPaths: sandboxWritableRoots,
				onSelect: (roots) => { setSelectedSandboxRoots(roots); setSandboxPickerOpen(false); } }} />;
	}

	if (creatingCredential) {
		return <CredentialDialog
			mode="draft"
			initialValue={credential ?? undefined}
			onClose={() => setCreatingCredential(false)}
			onSubmitted={(input) => {
				connectionTest.reset();
				setCredential(input);
				setSelectedSandboxRoots(null);
				setError(null);
				setCreatingCredential(false);
			}}
		/>;
	}

	return <ManagementDialog
		className="workspace-management-dialog"
		headerIcon={<Server size={23} strokeWidth={1.6} />}
		title={intl.formatMessage({ id: "workspace.create" })}
		description={intl.formatMessage({ id: "workspace.create.description" })}
		onClose={close}
		submitLabel={intl.formatMessage({ id: "workspace.create" })}
		submitting={submitting}
		submitDisabled={testing || !hasCredentialSecret(credential) || rootsError !== undefined}
		footerLeading={<span title={!testEnabled ? intl.formatMessage({ id: "workspace.testConnection.required" }) : undefined}>
			<button type="button" className="workspace-test-connection" disabled={!testEnabled || testing || submitting} aria-describedby={!testEnabled ? "connection-test-requirements" : undefined} aria-busy={testing} onClick={() => { if (testInput) void connectionTest.run(testInput); }}>
				{testing ? <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : <Cable size={14} aria-hidden="true" />}
				{intl.formatMessage({ id: testing ? "workspace.testConnection.loading" : "workspace.testConnection.button" })}
			</button>
			{!testEnabled ? <span id="connection-test-requirements" className="sr-only">{intl.formatMessage({ id: "workspace.testConnection.required" })}</span> : null}
		</span>}
		footerNotice={testState.status === "success" ? <NoticeCard tone="info" message={intl.formatMessage({ id: "workspace.testConnection.success" })} /> : testState.status === "error" ? <NoticeCard tone="error" message={localizedErrorMessage(testState.error)} /> : undefined}
		onSubmit={(event) => {
			event.preventDefault();
			if (connectionTest.getSnapshot().status === "testing" || submitting || !hasCredentialSecret(credential) || rootsError !== undefined) return;
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
				sandboxWritableRoots,
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
		<WorkspaceFormSection title={intl.formatMessage({ id: "workspace.section.identity" })} description={intl.formatMessage({ id: "workspace.section.identityHint" })}>
			<div className="workspace-form-identity">
				<DialogField label={intl.formatMessage({ id: "workspace.field.displayName" })} error={validationError(error, "displayName")}><input className={dialogInputClass} required autoFocus disabled={submitting} placeholder={intl.formatMessage({ id: "workspace.field.displayName.placeholder" })} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></DialogField>
				<DialogField label={intl.formatMessage({ id: "workspace.field.environment" })} error={validationError(error, "environment")}><CustomSelect ariaLabel={intl.formatMessage({ id: "workspace.field.environment" })} value={environment} disabled={submitting} onChange={(value) => setEnvironment(value as WorkspaceEnvironment)} options={[{ value: "production", label: intl.formatMessage({ id: "workspace.environment.production" }) }, { value: "staging", label: intl.formatMessage({ id: "workspace.environment.staging" }) }, { value: "development", label: intl.formatMessage({ id: "workspace.environment.development" }) }, { value: "other", label: intl.formatMessage({ id: "workspace.environment.other" }) }]} /></DialogField>
			</div>
		</WorkspaceFormSection>
		<WorkspaceFormSection title={intl.formatMessage({ id: "workspace.section.connection" })} description={<>
			{intl.formatMessage({ id: "workspace.section.connectionHint" })}
			<span className="workspace-connection-note"><LockKeyhole size={12} aria-hidden="true" />{intl.formatMessage({ id: "workspace.connection.immutableHint" })}</span>
		</>}>
			<div className="workspace-form-address">
				<DialogField label={intl.formatMessage({ id: "workspace.field.hostname" })} error={validationError(error, "host.hostname")}><input className={dialogInputClass} required disabled={submitting} placeholder="192.168.1.10" value={hostname} onChange={(event) => { connectionTest.reset(); setSelectedSandboxRoots(null); setHostname(event.target.value); }} /></DialogField>
				<DialogField label={intl.formatMessage({ id: "workspace.field.port" })} error={validationError(error, "host.port")}><input className={dialogInputClass} required disabled={submitting} type="number" min="1" max="65535" value={port} onChange={(event) => { connectionTest.reset(); setSelectedSandboxRoots(null); setPort(event.target.value); }} /></DialogField>
			</div>
			<WorkspaceCredentialField credential={credential} configured={hasCredentialSecret(credential)} disabled={submitting} onConfigure={configureCredential}
				error={error?.code === "validation_error" && error.field?.replace(/^body\./, "").startsWith("credential.") ? error.message : undefined} />
		</WorkspaceFormSection>
		<WorkspaceFormSection title={intl.formatMessage({ id: "workspace.section.directories" })} description={intl.formatMessage({ id: "workspace.section.directoriesHint" })}>
			<WorkspaceDirectoryField kind="local" label={intl.formatMessage({ id: "workspace.field.defaultCwd" })} path={defaultCwd}
				hint={intl.formatMessage({ id: "session.workDir.description" })} error={validationError(error, "defaultCwd")}
				actionLabel={intl.formatMessage({ id: "session.workDir.chooseLabel" })} disabled={submitting} onChoose={() => setDirectoryPickerOpen(true)} />
			<SandboxWritableRootsField roots={sandboxWritableRoots} hint={intl.formatMessage({ id: "sandbox.roots.workspaceHint" })} disabled={submitting || testing || !testEnabled}
				error={testEnabled ? rootsError ?? validationError(error, "sandboxWritableRoots") : undefined}
				onChoose={() => setSandboxPickerOpen(true)} onChange={setSelectedSandboxRoots} />
		</WorkspaceFormSection>
		<WorkspaceConnectionOptions hasError={error?.code === "validation_error" && error.field?.replace(/^body\./, "").startsWith("connection.") === true}>
			<DialogField label={intl.formatMessage({ id: "workspace.field.connectTimeout" })} error={validationError(error, "connection.connectTimeoutMs")}><input className={dialogInputClass} required type="number" min="1" value={connectTimeoutMs} onChange={(event) => { connectionTest.reset(); setConnectTimeoutMs(event.target.value); }} /></DialogField>
			<DialogField label={intl.formatMessage({ id: "workspace.field.keepaliveInterval" })} error={validationError(error, "connection.keepaliveIntervalMs")}><input className={dialogInputClass} required type="number" min="1" value={keepaliveIntervalMs} onChange={(event) => { connectionTest.reset(); setKeepaliveIntervalMs(event.target.value); }} /></DialogField>
			<DialogField label={intl.formatMessage({ id: "workspace.field.keepaliveMaxCount" })} error={validationError(error, "connection.keepaliveMaxCount")}><input className={dialogInputClass} required type="number" min="1" value={keepaliveMaxCount} onChange={(event) => { connectionTest.reset(); setKeepaliveMaxCount(event.target.value); }} /></DialogField>
		</WorkspaceConnectionOptions>
	</ManagementDialog>;
}
