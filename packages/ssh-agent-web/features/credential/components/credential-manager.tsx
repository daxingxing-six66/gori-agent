"use client";

import { Check, CirclePlus, KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
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
		<div className="flex items-center justify-between"><div><h2 className="text-[13px] font-semibold">{intl.formatMessage({ id: "credential.list.title" })}</h2><p className="mt-1 text-[10px] text-zinc-400">{intl.formatMessage({ id: "credential.list.description" })}</p></div><button className="flex h-8 items-center gap-1.5 rounded-lg bg-[#397b5c] px-3 text-[9px] font-semibold text-white" onClick={() => setDialogOpen(true)}><CirclePlus size={12} /> {intl.formatMessage({ id: "credential.create" })}</button></div>
		{error ? <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[10px] text-rose-700" role="alert"><span>{localizedErrorMessage(error)}</span><button className="shrink-0 font-semibold underline" onClick={() => void refreshAll()}>{intl.formatMessage({ id: "common.reload" })}</button></div> : null}
		{loading ? <section className="ui-card p-5 text-[10px] text-zinc-400">{intl.formatMessage({ id: "credential.loading" })}</section> : null}
		{!loading && credentials.map((credential) => <section key={credential.id} className="ui-card p-5">
			<div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-center gap-4"><div className="grid h-11 w-11 place-items-center rounded-xl bg-[#eaf2ec] text-[#397b5c]"><KeyRound size={20} /></div><div><div className="flex items-center gap-2"><h3 className="text-[13px] font-semibold">{credential.displayName}</h3>{credential.id === activeCredentialId ? <span className="rounded-md bg-[#eaf2ec] px-2 py-1 text-[8px] font-semibold text-[#397b5c]">{intl.formatMessage({ id: "credential.current" })}</span> : null}</div><p className="mt-1 text-[10px] text-zinc-400">{credential.type === "private_key" ? `SSH ${intl.formatMessage({ id: "credential.field.privateKey" })}` : intl.formatMessage({ id: "credential.field.password" })} · {intl.formatMessage({ id: "credential.version" }, { revision: credential.revision })}</p></div></div><div className="flex items-center gap-2">{credential.id !== activeCredentialId ? <button className="flex h-8 items-center gap-1.5 rounded-lg border border-[#9bb9a8] px-3 text-[9px] font-semibold text-[#397b5c] hover:bg-[#f5f8f5] disabled:cursor-not-allowed disabled:opacity-50" disabled={actionCredentialId !== null} onClick={() => void activate(credential.id)}><Check size={12} />{intl.formatMessage({ id: actionCredentialId === credential.id ? "credential.switching" : "credential.setActive" })}</button> : null}<button className="rounded-lg p-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-400" disabled={credential.id === activeCredentialId || actionCredentialId !== null} title={intl.formatMessage({ id: credential.id === activeCredentialId ? "credential.delete.blocked" : "credential.delete" })} aria-label={intl.formatMessage({ id: "credential.delete.named" }, { name: credential.displayName })} onClick={() => void remove(credential)}><Trash2 size={15} /></button></div></div>
			<div className="mt-5 grid gap-4 border-t border-zinc-100 pt-5 sm:grid-cols-3"><div><p className="text-[9px] uppercase tracking-[0.1em] text-zinc-400">{intl.formatMessage({ id: "credential.field.remoteUser" })}</p><p className="mt-1.5 font-mono text-[11px]">{credential.remoteUser}</p></div><div><p className="text-[9px] uppercase tracking-[0.1em] text-zinc-400">{intl.formatMessage({ id: "credential.field.authType" })}</p><p className="mt-1.5 font-mono text-[11px]">{intl.formatMessage({ id: credential.type === "private_key" ? "credential.field.privateKey" : "credential.field.password" })}</p></div><div><p className="text-[9px] uppercase tracking-[0.1em] text-zinc-400">{intl.formatMessage({ id: "credential.field.fingerprint" })}</p><p className="mt-1.5 truncate font-mono text-[11px]">{credential.type === "private_key" ? credential.publicKeyFingerprint ?? intl.formatMessage({ id: "credential.notProvided" }) : intl.formatMessage({ id: "credential.notApplicable" })}</p></div></div>
		</section>)}
		<section className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4"><div className="flex items-start gap-3"><KeyRound size={16} className="mt-0.5 text-sky-700" /><div><p className="text-[11px] font-semibold text-sky-900">{intl.formatMessage({ id: "credential.secret.title" })}</p><p className="mt-1 text-[10px] leading-5 text-sky-800/70">{intl.formatMessage({ id: "credential.secret.description" })}</p></div></div></section>
		{dialogOpen ? <CredentialDialog mode="create" workspaceId={workspaceId} onClose={() => setDialogOpen(false)} onSubmitted={() => { setDialogOpen(false); void load(); }} /> : null}
	</div>;
}
