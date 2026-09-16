"use client";

import { useState } from "react";
import { useIntl } from "react-intl";
import {
	DialogError,
	DialogField,
	ManagementDialog,
	dialogInputClass,
	dialogTextareaClass,
} from "@/components/management-dialog";
import { CustomSelect } from "@/components/custom-select";
import { credentialApi } from "@/features/credential/api/credential-api";
import type { CreateCredentialInput, Credential } from "@/features/credential/model/credential";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { ApiError } from "@/shared/errors/api-error";

type CredentialDialogProps =
	| {
			mode: "draft";
			initialValue?: CreateCredentialInput;
			onClose(): void;
			onSubmitted(input: CreateCredentialInput): void;
	  }
	| {
			mode: "create";
			workspaceId: string;
			onClose(): void;
			onSubmitted(credential: Credential): void;
	  };

function validationError(error: ApiError | null, field: string): string | undefined {
	if (error?.code !== "validation_error") return undefined;
	const errorField = error.field?.replace(/^body\./, "");
	return errorField === field ? error.message : undefined;
}

export function CredentialDialog(props: CredentialDialogProps) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const initialValue = props.mode === "draft" ? props.initialValue : undefined;
	const [displayName, setDisplayName] = useState(initialValue?.displayName ?? "");
	const [remoteUser, setRemoteUser] = useState(initialValue?.remoteUser ?? "");
	const [type, setType] = useState<"private_key" | "password">(initialValue?.type ?? "private_key");
	const [privateKey, setPrivateKey] = useState(initialValue?.type === "private_key" ? initialValue.privateKey : "");
	const [passphrase, setPassphrase] = useState(initialValue?.type === "private_key" ? initialValue.passphrase ?? "" : "");
	const [password, setPassword] = useState(initialValue?.type === "password" ? initialValue.password : "");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<ApiError | null>(null);

	return (
		<ManagementDialog
			title={intl.formatMessage({ id: props.mode === "draft" ? "credential.dialog.draft.title" : "credential.dialog.create.title" })}
			description={intl.formatMessage({ id: props.mode === "draft" ? "credential.dialog.draft.description" : "credential.dialog.create.description" })}
			onClose={props.onClose}
			submitLabel={intl.formatMessage({ id: props.mode === "draft" ? "credential.dialog.draft.submit" : "credential.dialog.create.submit" })}
			submitting={submitting}
			onSubmit={(event) => {
				event.preventDefault();
				setError(null);
				const input: CreateCredentialInput = type === "private_key"
					? { displayName, remoteUser, type, privateKey, ...(passphrase ? { passphrase } : {}) }
					: { displayName, remoteUser, type, password };
				if (props.mode === "draft") {
					props.onSubmitted(input);
					return;
				}
				setSubmitting(true);
				void credentialApi.create(props.workspaceId, input)
					.then(props.onSubmitted)
					.catch((requestError: unknown) =>
						setError(
							requestError instanceof ApiError
								? requestError
								: new ApiError(0, "network_error", localizedErrorMessage(requestError)),
						),
					)
					.finally(() => {
						setPrivateKey("");
						setPassphrase("");
						setPassword("");
						setSubmitting(false);
					});
			}}
		>
			<DialogError message={error ? localizedErrorMessage(error) : null} />
			<div className="grid gap-4 sm:grid-cols-2">
				<DialogField label={intl.formatMessage({ id: "credential.field.displayName" })} error={validationError(error, "displayName")}><input className={dialogInputClass} required autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></DialogField>
				<DialogField label={intl.formatMessage({ id: "credential.field.remoteUser" })} error={validationError(error, "remoteUser")}><input className={dialogInputClass} required value={remoteUser} onChange={(event) => setRemoteUser(event.target.value)} autoComplete="username" /></DialogField>
			</div>
			<DialogField label={intl.formatMessage({ id: "credential.field.authType" })} error={validationError(error, "type")}>
				<CustomSelect ariaLabel={intl.formatMessage({ id: "credential.field.authType" })} value={type} onChange={(value) => setType(value === "password" ? "password" : "private_key")} options={[{ value: "private_key", label: intl.formatMessage({ id: "credential.field.privateKey" }) }, { value: "password", label: intl.formatMessage({ id: "credential.field.password" }) }]} />
			</DialogField>
			{type === "private_key" ? <>
				<DialogField label={intl.formatMessage({ id: "credential.field.privateKey" })} error={validationError(error, "privateKey")}><textarea className={dialogTextareaClass} required value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} autoComplete="off" /></DialogField>
				<DialogField label={intl.formatMessage({ id: "credential.field.passphrase" })} hint={intl.formatMessage({ id: "common.optional" })} error={validationError(error, "passphrase")}><input className={dialogInputClass} type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" /></DialogField>
			</> : <DialogField label={intl.formatMessage({ id: "credential.field.password" })} error={validationError(error, "password")}><input className={dialogInputClass} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></DialogField>}
		</ManagementDialog>
	);
}
