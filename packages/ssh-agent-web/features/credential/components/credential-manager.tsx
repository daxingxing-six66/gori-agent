"use client";

import { Check, CirclePlus, KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { PageHeading } from "@/components/page-layout";
import "./credential-manager.css";
import { credentialApi } from "@/features/credential/api/credential-api";
import { CredentialDialog } from "@/features/credential/components/credential-dialog";
import type { Credential } from "@/features/credential/model/credential";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";

export function CredentialManager({ workspaceId }: { workspaceId: string }) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const { refresh: refreshWorkspaceTree } = useWorkspaceTree();
	const [credentials, setCredentials] = useState<Credential[]>([]);
	const [activeCredentialId, setActiveCredentialId] = useState<string | null>(null);
	const [workspaceRevision, setWorkspaceRevision] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [actionCredentialId, setActionCredentialId] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);

	const load = useCallback(async (signal?: AbortSignal) => {
		try {
			const list = await credentialApi.list(workspaceId, signal);
			setCredentials(list.credentials);
			setActiveCredentialId(list.activeCredentialId);
			setWorkspaceRevision(list.workspaceRevision);
			setError(null);
		} catch (requestError) {
			if (!signal?.aborted) setError(requestError);
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, [workspaceId]);

	useEffect(() => {
		const controller = new AbortController();
		credentialApi.list(workspaceId, controller.signal).then((list) => {
			setCredentials(list.credentials);
			setActiveCredentialId(list.activeCredentialId);
			setWorkspaceRevision(list.workspaceRevision);
			setError(null);
		}).catch((requestError: unknown) => {
			if (!controller.signal.aborted) setError(requestError);
		}).finally(() => {
			if (!controller.signal.aborted) setLoading(false);
		});
		return () => controller.abort();
	}, [workspaceId]);

	const refreshAll = async () => {
		await Promise.all([load(), refreshWorkspaceTree()]);
	};

	const activate = async (credentialId: string) => {
		if (workspaceRevision === null || actionCredentialId !== null) return;
		setActionCredentialId(credentialId);
		setError(null);
		try {
			const result = await credentialApi.activate(workspaceId, credentialId, workspaceRevision);
			setActiveCredentialId(result.activeCredential.id);
			setWorkspaceRevision(result.workspace.revision);
			await refreshAll();
		} catch (requestError) {
			const requestFailure = requestError;
			await refreshAll();
			setError(requestFailure);
		} finally {
			setActionCredentialId(null);
		}
	};

	const remove = async (credential: Credential) => {
		if (credential.id === activeCredentialId || actionCredentialId !== null) return;
		if (!window.confirm(intl.formatMessage({ id: "credential.delete.confirm" }, { name: credential.displayName }))) return;
		setActionCredentialId(credential.id);
		setError(null);
		try {
			await credentialApi.delete(workspaceId, credential.id, credential.revision);
			await load();
		} catch (requestError) {
			const requestFailure = requestError;
			await refreshAll();
			setError(requestFailure);
		} finally {
			setActionCredentialId(null);
		}
	};

	return <div className="space-y-5">
		<PageHeading title={intl.formatMessage({ id: "credential.list.title" })} description={intl.formatMessage({ id: "credential.list.description" })} actions={<button type="button" className="page-button page-button-primary" onClick={() => setDialogOpen(true)}><CirclePlus size={13} />{intl.formatMessage({ id: "credential.create" })}</button>} />
		{error ? <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[10px] text-rose-700" role="alert"><span>{localizedErrorMessage(error)}</span><button className="shrink-0 font-semibold underline" onClick={() => void refreshAll()}>{intl.formatMessage({ id: "common.reload" })}</button></div> : null}
		{loading ? <section className="ui-card p-5 text-[10px] text-zinc-400">{intl.formatMessage({ id: "credential.loading" })}</section> : null}
		{!loading ? <div className="ui-card credential-list">
			{credentials.map((credential) => {
				const active = credential.id === activeCredentialId;
				const fingerprint = credential.type === "private_key" ? credential.publicKeyFingerprint ?? intl.formatMessage({ id: "credential.notProvided" }) : intl.formatMessage({ id: "credential.notApplicable" });
				return <section key={credential.id} className="credential-row">
					<KeyRound size={15} aria-hidden="true" className="credential-row-icon" />
					<div className="credential-row-content">
						<div className="credential-row-title"><h3>{credential.displayName}</h3>{active ? <span>{intl.formatMessage({ id: "credential.current" })}</span> : null}</div>
						<dl className="credential-row-details">
							<div><dt>{intl.formatMessage({ id: "credential.field.remoteUser" })}</dt><dd>{credential.remoteUser}</dd></div>
							<div><dt>{intl.formatMessage({ id: "credential.field.authType" })}</dt><dd>{intl.formatMessage({ id: credential.type === "private_key" ? "credential.field.privateKey" : "credential.field.password" })} · {intl.formatMessage({ id: "credential.version" }, { revision: credential.revision })}</dd></div>
						</dl>
						<p className="credential-fingerprint" title={fingerprint}><span>{intl.formatMessage({ id: "credential.field.fingerprint" })}</span>{fingerprint}</p>
					</div>
					<div className="credential-row-actions">
						{!active ? <button type="button" className="page-button" disabled={actionCredentialId !== null} onClick={() => void activate(credential.id)}><Check size={12} />{intl.formatMessage({ id: actionCredentialId === credential.id ? "credential.switching" : "credential.setActive" })}</button> : null}
						<button type="button" className="page-icon-button page-icon-button-danger" disabled={active || actionCredentialId !== null} title={intl.formatMessage({ id: active ? "credential.delete.blocked" : "credential.delete" })} aria-label={intl.formatMessage({ id: "credential.delete.named" }, { name: credential.displayName })} onClick={() => void remove(credential)}><Trash2 size={14} /></button>
					</div>
				</section>;
			})}
		</div> : null}
		<div className="page-muted-notice"><KeyRound size={13} aria-hidden="true" /><p><span className="font-medium">{intl.formatMessage({ id: "credential.secret.title" })}</span> · {intl.formatMessage({ id: "credential.secret.description" })}</p></div>
		{dialogOpen ? <CredentialDialog mode="create" workspaceId={workspaceId} onClose={() => setDialogOpen(false)} onSubmitted={() => { setDialogOpen(false); void load(); }} /> : null}
	</div>;
}
