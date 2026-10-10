"use client";

import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";

export function SessionSandboxStatus({ pending, label, error, notice, onDismiss }: {
	pending: boolean; label: string; error: unknown; notice: string | null; onDismiss(): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	if (!pending && !error && !notice) return null;
	return <div className="border-b border-[var(--line-soft)] px-6 py-2 text-xs" aria-live="polite">
		{pending ? <span className="text-faint">{label} · {intl.formatMessage({ id: "session.sandbox.restarting" })}</span> : null}
		{error || notice ? <button type="button" className={`mt-1 text-left ${error ? "text-danger" : "text-secondary"}`} onClick={onDismiss}>{error ? localizedErrorMessage(error) : notice}</button> : null}
	</div>;
}
