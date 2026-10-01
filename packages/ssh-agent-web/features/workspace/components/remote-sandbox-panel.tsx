"use client";

import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { workspaceApi } from "../api/workspace-api";
import { isRemoteSandboxRoot, type Workspace } from "../model/workspace";

export function RemoteSandboxPanel({ workspace }: { workspace: Workspace }) {
	const intl = useIntl();
	const errorMessage = useLocalizedErrorMessage();
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string>();
	const [result, setResult] = useState<Awaited<ReturnType<typeof workspaceApi.probeSandbox>>>();
	const [checkedAt, setCheckedAt] = useState<number>();
	const controller = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => controller.current?.abort(), []);
	const check = async () => {
		if (checking) return;
		const request = new AbortController();
		controller.current = request;
		setChecking(true);
		setResult(undefined);
		setError(undefined);
		try {
			const snapshot = await workspaceApi.probeSandbox(workspace.id, request.signal);
			if (!request.signal.aborted) { setResult(snapshot); setCheckedAt(Date.now()); }
		} catch (cause) {
			if (!request.signal.aborted) { setError(errorMessage(cause)); setCheckedAt(Date.now()); }
		} finally {
			if (!request.signal.aborted) setChecking(false);
		}
	};
	return <section className="ui-card p-5">
		<div className="flex items-center justify-between gap-4">
			<h2 className="text-[13px] font-semibold">{intl.formatMessage({ id: "workspace.sandbox.title" })}</h2>
			<button type="button" className="rounded-lg border border-[var(--line)] px-3 py-2 text-[10px] disabled:opacity-50" disabled={checking || !isRemoteSandboxRoot(workspace.remoteDefaultCwd ?? "/")} onClick={() => void check()}>
				{intl.formatMessage({ id: checking ? "workspace.sandbox.checking" : "workspace.sandbox.check" })}
			</button>
		</div>
		<p role="status" className="mt-3 text-[11px]">{intl.formatMessage({ id: error ? "workspace.sandbox.unavailable" : result ? "workspace.sandbox.full" : "workspace.sandbox.notProbed" })}{result ? ` · ABI ${result.abi}` : ""}</p>
		<p className="mt-2 break-all font-mono text-[11px]">{result?.sandboxRoot ?? (isRemoteSandboxRoot(workspace.remoteDefaultCwd ?? "/") ? workspace.remoteDefaultCwd : intl.formatMessage({ id: "workspace.sandbox.notConfigured" }))}</p>
		{error ? <p role="alert" className="mt-2 text-[11px] text-rose-600">{error}</p> : null}
		{checkedAt ? <p className="mt-2 text-[10px] text-[var(--text-secondary)]">{intl.formatMessage({ id: "workspace.sandbox.checkedAt" }, { time: new Date(checkedAt).toLocaleString(intl.locale) })}</p> : null}
		<p className="mt-3 text-[10px] leading-5 text-[var(--text-secondary)]">{intl.formatMessage({ id: "workspace.sandbox.scope" })}</p>
	</section>;
}
