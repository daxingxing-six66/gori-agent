"use client";

import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { llmProviderApi } from "@/features/llm-provider/api/llm-provider-api";
import type { LlmModel, LlmProvider } from "@/features/llm-provider/model/llm-provider";

/** Reads the effective runtime catalog; only an explicit refresh changes its source. */
export function ProviderModelsPanel({ provider, initialRefresh, onBusyChange, onRefreshed }: {
	provider: LlmProvider;
	initialRefresh: boolean;
	onBusyChange(busy: boolean): void;
	onRefreshed(): Promise<void>;
}) {
	const intl = useIntl();
	const localizeError = useLocalizedErrorMessage();
	const [models, setModels] = useState<readonly LlmModel[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(initialRefresh);
	const [error, setError] = useState<string | null>(null);
	const [refreshed, setRefreshed] = useState(false);
	const [query, setQuery] = useState("");
	const operation = useRef<AbortController | null>(null);
	const onRefreshedRef = useRef(onRefreshed);
	useEffect(() => { onRefreshedRef.current = onRefreshed; }, [onRefreshed]);
	useEffect(() => { onBusyChange(refreshing); }, [onBusyChange, refreshing]);
	useEffect(() => () => onBusyChange(false), [onBusyChange]);

	const request = useCallback(async (refresh: boolean, controller: AbortController) => {
		setError(null);
		setRefreshed(false);
		if (refresh) setRefreshing(true);
		else setLoading(true);
		try {
			const result = await (refresh ? llmProviderApi.refreshModels : llmProviderApi.listModels)(provider.id, controller.signal);
			if (controller.signal.aborted) return;
			setModels(result.models);
			if (refresh) await onRefreshedRef.current();
			if (!controller.signal.aborted) setRefreshed(refresh);
		} catch (failure) {
			if (!controller.signal.aborted) setError(localizeError(failure));
		} finally {
			if (operation.current === controller) operation.current = null;
			if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
		}
	}, [localizeError, provider.id]);

	useEffect(() => {
		const controller = new AbortController();
		operation.current = controller;
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted) return;
			// Keep the last catalog visible if a refresh fails, including when launched from a row.
			if (initialRefresh) {
				try {
					const result = await llmProviderApi.listModels(provider.id, controller.signal);
					if (!controller.signal.aborted) setModels(result.models);
				} catch { /* A failed read does not prevent an explicit source refresh. */ }
			}
			if (!controller.signal.aborted) await request(initialRefresh, controller);
		});
		return () => { controller.abort(); if (operation.current === controller) operation.current = null; };
	}, [initialRefresh, provider.id, request]);

	const refresh = () => {
		if (operation.current || !provider.configured) return;
		const controller = new AbortController();
		operation.current = controller;
		void request(true, controller);
	};
	useEffect(() => () => operation.current?.abort(), []);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visible = models?.filter((model) => `${model.name} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery)) ?? [];
	const auth = provider.credential?.type === "oauth" ? "OAuth" : provider.auth.apiKey ? "API Key" : intl.formatMessage({ id: "provider.auth.none" });
	return <div className="provider-models-panel space-y-5 text-[var(--ink)]">
		<dl className="grid gap-4 rounded-xl border border-[var(--line-soft)] bg-[var(--surface-muted)] p-4 text-[11px] sm:grid-cols-2">
			<div><dt className="text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.id" })}</dt><dd className="mt-1 break-all font-mono">{provider.id}</dd></div>
			<div><dt className="text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.auth" })}</dt><dd className="mt-1">{auth}</dd></div>
			<div className="sm:col-span-2"><dt className="text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.endpoint" })}</dt><dd className="mt-1 break-all font-mono">{provider.baseUrl ?? intl.formatMessage({ id: "provider.credential.endpoint.runtime" })}</dd></div>
		</dl>
		<div className="flex flex-wrap items-start justify-between gap-3">
			<div><h3 className="text-[12px] font-semibold">{intl.formatMessage({ id: "provider.models.count" }, { count: models?.length ?? provider.modelCount })}</h3>
				<p className="mt-1 max-w-[480px] text-[11px] leading-5 text-[var(--text-muted)]">{intl.formatMessage({ id: provider.custom ? "provider.models.refreshHint.custom" : provider.id === "openai-chatgpt" ? "provider.models.refreshHint.subscription" : "provider.models.refreshHint.builtin" })}</p></div>
			<button type="button" className="provider-action" disabled={loading || refreshing || !provider.configured} onClick={refresh}>
				<RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />
				{intl.formatMessage({ id: refreshing ? "provider.models.refreshing" : "provider.models.refresh" })}
			</button>
		</div>
		{error ? <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3 text-[11px] text-[var(--danger)]" role="alert">{error}
			{models === null ? <button type="button" className="provider-action ml-3" disabled={loading || refreshing} onClick={() => {
				if (operation.current) return;
				const controller = new AbortController(); operation.current = controller; void request(false, controller);
			}}>{intl.formatMessage({ id: "common.reload" })}</button> : null}</div> : null}
		{refreshed ? <p role="status" className="text-[11px] text-[var(--accent-ink)]">{intl.formatMessage({ id: "provider.models.refreshed" })}</p> : null}
		{loading && models === null ? <p role="status" className="py-6 text-center text-[11px] text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.selector.catalogLoading" })}</p> : null}
		{models && models.length > 0 ? <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-[var(--text-muted)] focus-within:border-[var(--accent)]"><Search size={14} aria-hidden="true" />
			<input type="search" className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--ink)] outline-none" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={intl.formatMessage({ id: "provider.models.search" })} placeholder={intl.formatMessage({ id: "provider.models.search" })} />
		</label> : null}
		{models?.length === 0 ? <p className="py-6 text-center text-[11px] text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.empty" })}</p> : models && visible.length === 0 ? <p className="py-6 text-center text-[11px] text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.noMatch" })}</p> : null}
		<ul className="space-y-2" aria-label={intl.formatMessage({ id: "provider.custom.field.catalog" })}>
			{visible.map((model) => <li key={model.id} className="rounded-lg border border-[var(--line-soft)] px-4 py-3">
				<p className="text-[12px] font-semibold">{model.name}</p><p className="mt-1 break-all font-mono text-[10px] text-[var(--text-muted)]">{model.id}</p>
				<dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[10px] text-[var(--text-secondary)]">
					<div><dt className="inline text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.context" })}: </dt><dd className="inline">{intl.formatNumber(model.contextWindow)}</dd></div>
					<div><dt className="inline text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.output" })}: </dt><dd className="inline">{intl.formatNumber(model.maxTokens)}</dd></div>
					<div><dt className="sr-only">{intl.formatMessage({ id: "provider.custom.field.protocol" })}</dt><dd>{model.api}</dd></div>
					<div><dt className="sr-only">{intl.formatMessage({ id: "provider.models.input" })}</dt><dd>{model.input.map((type) => intl.formatMessage({ id: type === "image" ? "provider.models.image" : "provider.models.text" })).join(" · ")}</dd></div>
					{model.reasoning ? <div><dt className="inline text-[var(--text-muted)]">{intl.formatMessage({ id: "provider.models.thinking" })}: </dt><dd className="inline">{model.supportedThinkingLevels.map((level) => intl.formatMessage({ id: `provider.thinking.${level}` })).join(" · ")}</dd></div> : null}
				</dl>
			</li>)}
		</ul>
	</div>;
}
