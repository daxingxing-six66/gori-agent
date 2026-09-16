"use client";

import { useState } from "react";
import { useIntl } from "react-intl";
import { DialogError, DialogField, ManagementDialog, dialogInputClass } from "@/components/management-dialog";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";

export function NameDialog({ title, initialValue = "", submitLabel, onClose, onSubmit }: {
	title: string;
	initialValue?: string;
	submitLabel: string;
	onClose(): void;
	onSubmit(displayName: string): Promise<void>;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [displayName, setDisplayName] = useState(initialValue);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return <ManagementDialog title={title} onClose={onClose} submitLabel={submitLabel} submitting={submitting} onSubmit={(event) => {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		void onSubmit(displayName).catch((requestError: unknown) => setError(localizedErrorMessage(requestError))).finally(() => setSubmitting(false));
	}}>
		<DialogError message={error} />
		<DialogField label={intl.formatMessage({ id: "workspace.field.displayName" })}><input className={dialogInputClass} required autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></DialogField>
	</ManagementDialog>;
}
