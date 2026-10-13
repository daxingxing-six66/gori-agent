"use client";

import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { DialogError, ManagementDialog } from "@/components/management-dialog";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import type { Workspace } from "@/features/workspace/model/workspace";
import { sessionApi } from "../api/session-api";
import type { Session } from "../model/session";
import { SessionDialog, type SessionDialogInput } from "./session-dialog";

/** Loads one editing snapshot; saving keeps its revision instead of silently adopting a newer one. */
export function SessionEditDialog({ sessionId, workspace, onClose, onUpdated }: {
	sessionId: string;
	workspace: Workspace;
	onClose(): void;
	onUpdated(sessionId: string): Promise<void>;
}) {
	const intl = useIntl();
	const errorMessage = useLocalizedErrorMessage();
	const [session, setSession] = useState<Session | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [reloadVersion, setReloadVersion] = useState(0);
	useEffect(() => {
		const request = new AbortController();
		void sessionApi.get(sessionId, request.signal).then((current) => {
			if (!request.signal.aborted) setSession(current);
		}).catch((error: unknown) => { if (!request.signal.aborted) setLoadError(error); });
		return () => request.abort();
	}, [sessionId, reloadVersion]);

	const reload = () => { setSession(null); setLoadError(null); setReloadVersion((version) => version + 1); };
	const save = async (input: SessionDialogInput) => {
		if (!session) return;
		try {
			await sessionApi.update(sessionId, { ...input, expectedRevision: session.revision });
			await onUpdated(sessionId);
			onClose();
		} catch (error) {
			// A setting may have committed before reopening the PTY failed; refresh its projections.
			await onUpdated(sessionId).catch(() => undefined);
			throw error;
		}
	};
	if (session) return <SessionDialog key={`${sessionId}:${reloadVersion}`} session={session} workspace={workspace} onClose={onClose} onReload={reload} onSubmit={save} />;
	return <ManagementDialog title={intl.formatMessage({ id: "session.edit" })} onClose={onClose}
		submitting={false} submitDisabled submitLabel={intl.formatMessage({ id: "common.save" })} onSubmit={(event) => event.preventDefault()}>
		{loadError ? <><DialogError message={errorMessage(loadError)} /><button type="button" className="text-xs text-accent" onClick={reload}>{intl.formatMessage({ id: "common.reload" })}</button></>
			: <p className="text-xs text-secondary">{intl.formatMessage({ id: "session.loading" })}</p>}
	</ManagementDialog>;
}
