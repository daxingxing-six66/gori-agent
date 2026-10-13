"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { workspaceApi } from "../api/workspace-api";
import { type Workspace } from "../model/workspace";
import { configuredSandboxWritableRoots, sandboxFactRoots, validSandboxWritableRoots } from "../model/sandbox-writable-roots";
import "./remote-sandbox-panel.css";

export function RemoteSandboxPanel({ workspace }: { workspace: Workspace }) {
	const intl = useIntl();
	const errorMessage = useLocalizedErrorMessage();
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string>();
	const [result, setResult] = useState<Awaited<ReturnType<typeof workspaceApi.probeSandbox>>>();
	const [checkedAt, setCheckedAt] = useState<number>();
	const configuredRoots = configuredSandboxWritableRoots(workspace);
	const roots = result ? sandboxFactRoots(result) : configuredRoots;
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
	return <section className="ui-card remote-sandbox-panel">
		<h3><ShieldCheck size={14} aria-hidden="true" />{intl.formatMessage({ id: "workspace.sandbox.title" })}</h3>
		<p role="status" className="remote-sandbox-status">{intl.formatMessage({ id: error ? "workspace.sandbox.unavailable" :
			result?.backend === "landlock" ? "workspace.sandbox.full" :
			result?.backend === "bubblewrap" ? "workspace.sandbox.bubblewrap" : "workspace.sandbox.notProbed" })}
			{result?.backend === "landlock" ? ` · ABI ${result.abi}` :
				result?.backend === "bubblewrap" ? ` · ${result.bubblewrapVersion}` : ""}</p>
		<div className="remote-sandbox-path">{roots.length > 0 ? roots.map((root) => <p key={root} title={root}>{root}</p>) : intl.formatMessage({ id: "workspace.sandbox.notConfigured" })}</div>
		{error ? <p role="alert" className="mt-2 text-[11px] text-rose-600">{error}</p> : null}
		{checkedAt ? <p className="mt-2 text-[10px] text-[var(--text-secondary)]">{intl.formatMessage({ id: "workspace.sandbox.checkedAt" }, { time: new Date(checkedAt).toLocaleString(intl.locale) })}</p> : null}
		<button type="button" className="page-button mt-3" disabled={checking || !validSandboxWritableRoots(configuredRoots)} onClick={() => void check()}>
			{intl.formatMessage({ id: checking ? "workspace.sandbox.checking" : "workspace.sandbox.check" })}
		</button>
		<details className="remote-sandbox-scope"><summary>{intl.formatMessage({ id: "workspace.sandbox.scopeTitle" })}<ChevronDown size={12} aria-hidden="true" /></summary><p>{intl.formatMessage({ id: "workspace.sandbox.scope" })}</p></details>
	</section>;
}
