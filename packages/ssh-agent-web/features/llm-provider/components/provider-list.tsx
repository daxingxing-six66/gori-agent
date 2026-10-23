"use client";

import { Bot, Check, ChevronRight, KeyRound, List, LockKeyhole, Plus, RotateCw } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { type CustomLlmProvider, type LlmProvider, deriveLlmProviderState } from "@/features/llm-provider/model/llm-provider";

export type ProviderListTab = "connections" | "custom";

export function ProviderList({ activeTab, onTabChange, busy, subscription, providers, providersError, providerState,
	loading, customProviders, customError, customLoading, onReloadProviders, onReloadCustomProviders,
	onCreateCustom, onEditCustom, onCreateCredential, onEditCredential, onViewModels, onRefreshModels,
}: {
	activeTab: ProviderListTab;
	onTabChange(tab: ProviderListTab): void;
	busy: boolean;
	subscription: ReactNode;
	providers: readonly LlmProvider[] | null;
	providersError: unknown;
	providerState: ReturnType<typeof deriveLlmProviderState>;
	loading: boolean;
	customProviders: readonly CustomLlmProvider[] | null;
	customError: unknown;
	customLoading: boolean;
	onReloadProviders(): void;
	onReloadCustomProviders(): void;
	onCreateCustom(): void;
	onEditCustom(providerId: string): void;
	onCreateCredential(providerId?: string): void;
	onEditCredential(provider: LlmProvider): void;
	onViewModels(providerId: string): void;
	onRefreshModels(providerId: string): void;
}) {
	const intl = useIntl();
	const localizeError = useLocalizedErrorMessage();
	const id = useId();
	const credentials = providerState.credentialProviders.filter((provider) => !provider.custom);
	const tabs = ["connections", "custom"] as const;
	return <div className="provider-settings-list">
		<div className="provider-list-tabs" role="tablist" aria-label={intl.formatMessage({ id: "provider.tabs.label" })}>
			{tabs.map((tab, index) => <button key={tab} id={`${id}-${tab}`} type="button" role="tab"
				aria-selected={activeTab === tab} aria-controls={`${id}-panel`} tabIndex={!busy && activeTab === tab ? 0 : -1}
				disabled={busy} onClick={() => onTabChange(tab)} onKeyDown={(event) => {
					if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || busy) return;
					event.preventDefault();
					const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : (index + 1) % tabs.length;
					onTabChange(tabs[next]);
					event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
				}}>
				{intl.formatMessage({ id: tab === "connections" ? "provider.connections.title" : "provider.custom.title" })}
				{tab === "custom" && customProviders ? <span className="provider-list-count">{customProviders.length}</span> : null}
			</button>)}
		</div>
		<div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${activeTab}`} tabIndex={0} className="provider-list-panel">
			{activeTab === "connections" ? <div className="provider-list-groups">
				{subscription ? <section aria-label={intl.formatMessage({ id: "provider.connections.subscription" })}>
					<h3 className="provider-group-label">{intl.formatMessage({ id: "provider.connections.subscription" })}</h3>
					{subscription}
				</section> : null}
				<section aria-label={intl.formatMessage({ id: "provider.credential.title" })}>
					<div className="provider-list-heading">
						<h3 className="provider-group-label">{intl.formatMessage({ id: "provider.credential.title" })}</h3>
						<button type="button" className="provider-action" disabled={busy || loading} onClick={() => onCreateCredential()}>
							<Plus size={14} aria-hidden="true" />{intl.formatMessage({ id: "provider.credential.add" })}
						</button>
					</div>
					{providersError && providers === null ? <ReloadState message={localizeError(providersError)} onReload={onReloadProviders} /> : null}
					{loading && providers === null ? <p className="provider-list-loading" role="status">{intl.formatMessage({ id: "provider.credential.loading" })}</p> : null}
					{providers !== null && credentials.length === 0 ? <EmptyState kind="credential" /> : null}
					<div className="provider-rows">
						{credentials.map((provider) => <div key={provider.id} className="provider-row provider-custom-row">
							<button type="button" className="provider-custom-identity" disabled={busy} onClick={() => onEditCredential(provider)}>
								<ProviderIdentity name={provider.name} description={provider.baseUrl ?? "API Key"} />
								<ChevronRight size={14} className="provider-row-chevron" aria-hidden="true" />
							</button>
							<div className="provider-custom-actions">
								<ProviderStatus configured={provider.configured} />
								<ModelActions disabled={busy} refreshDisabled={!provider.configured} onView={() => onViewModels(provider.id)} onRefresh={() => onRefreshModels(provider.id)} />
							</div>
						</div>)}
					</div>
				</section>
				<p className="provider-security-note"><LockKeyhole size={13} aria-hidden="true" />{intl.formatMessage({ id: "provider.connection.security" })}</p>
			</div> : <section aria-label={intl.formatMessage({ id: "provider.custom.title" })}>
				<div className="provider-list-heading provider-custom-heading">
					<p>{intl.formatMessage({ id: "provider.custom.description" })}</p>
					<button type="button" className="provider-action provider-action-primary" disabled={busy || customLoading} onClick={onCreateCustom}>
						<Plus size={14} aria-hidden="true" />{intl.formatMessage({ id: "provider.custom.add" })}
					</button>
				</div>
				{customError && customProviders === null ? <ReloadState message={localizeError(customError)} onReload={onReloadCustomProviders} /> : null}
				{customLoading && customProviders === null ? <p className="provider-list-loading" role="status">{intl.formatMessage({ id: "provider.custom.loading" })}</p> : null}
				{customProviders?.length === 0 ? <EmptyState kind="custom" /> : null}
				<div className="provider-rows">
					{customProviders?.map((provider) => {
						const catalog = providers?.find((entry) => entry.id === provider.id);
						return <div key={provider.id} className="provider-row provider-custom-row">
							<button type="button" className="provider-custom-identity" disabled={busy || customLoading} onClick={() => onEditCustom(provider.id)}>
								<ProviderIdentity name={provider.name} description={provider.baseUrl} />
								<ChevronRight size={14} className="provider-row-chevron" aria-hidden="true" />
							</button>
							<div className="provider-custom-actions">
								<ProviderStatus configured={catalog?.configured ?? false} />
								<ModelActions disabled={busy || customLoading || !catalog} refreshDisabled={!catalog?.configured} onView={() => onViewModels(provider.id)} onRefresh={() => onRefreshModels(provider.id)} />
								{provider.authMode === "api_key" ? <button type="button" className="provider-action" disabled={busy || !catalog}
									onClick={() => catalog?.credential ? onEditCredential(catalog) : onCreateCredential(provider.id)}>
									<KeyRound size={13} aria-hidden="true" />{intl.formatMessage({ id: catalog?.credential ? "provider.credential.manage" : "provider.credential.configure" })}
								</button> : null}
							</div>
						</div>;
					})}
				</div>
			</section>}
		</div>
	</div>;
}

function ModelActions({ disabled, refreshDisabled, onView, onRefresh }: { disabled: boolean; refreshDisabled: boolean; onView(): void; onRefresh(): void }) {
	const intl = useIntl();
	return <>
		<button type="button" className="provider-action" disabled={disabled} onClick={onView}><List size={13} aria-hidden="true" />{intl.formatMessage({ id: "provider.models.view" })}</button>
		<button type="button" className="provider-action" disabled={disabled || refreshDisabled} onClick={onRefresh}><RotateCw size={13} aria-hidden="true" />{intl.formatMessage({ id: "provider.models.refresh" })}</button>
	</>;
}

function ProviderIdentity({ name, description }: { name: string; description: string }) {
	return <span className="provider-identity">
		<span className="provider-avatar" aria-hidden="true">{name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>
		<span className="provider-identity-copy"><strong>{name}</strong><span title={description}>{description}</span></span>
	</span>;
}

function ProviderStatus({ configured }: { configured: boolean }) {
	const intl = useIntl();
	return <span className="provider-status" data-configured={configured}>
		{configured ? <Check size={12} aria-hidden="true" /> : <span className="provider-status-dot" />}
		{intl.formatMessage({ id: configured ? "provider.status.available" : "provider.status.authPending" })}
	</span>;
}

function EmptyState({ kind }: { kind: "custom" | "credential" }) {
	const intl = useIntl();
	return <div className="provider-empty">
		<span className="provider-avatar" aria-hidden="true">{kind === "custom" ? <Bot size={18} /> : <KeyRound size={18} />}</span>
		<div><p>{intl.formatMessage({ id: kind === "custom" ? "provider.custom.empty" : "provider.credential.empty" })}</p>
			<span>{intl.formatMessage({ id: kind === "custom" ? "provider.custom.empty.description" : "provider.credential.empty.description" })}</span></div>
	</div>;
}

function ReloadState({ message, onReload }: { message: string; onReload(): void }) {
	const intl = useIntl();
	return <div className="provider-list-error" role="alert"><p>{message}</p>
		<button type="button" className="provider-action" onClick={onReload}><RotateCw size={13} aria-hidden="true" />{intl.formatMessage({ id: "common.reload" })}</button>
	</div>;
}
