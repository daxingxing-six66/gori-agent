"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useIntl, type IntlShape } from "react-intl";
import { CustomSelect, type CustomSelectOption } from "@/components/custom-select";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { llmProviderApi } from "@/features/llm-provider/api/llm-provider-api";
import { CustomProviderEditor } from "@/features/llm-provider/components/custom-provider-editor";
import { ProviderList, type ProviderListTab } from "@/features/llm-provider/components/provider-list";
import { ChatGptConnection } from "@/features/llm-provider/components/chatgpt-connection";
import { useLlmProviders } from "@/features/llm-provider/components/llm-provider-context";
import {
	type CustomLlmProvider,
	deriveLlmProviderState,
	type LlmProvider,
	type LlmProviderCredential,
} from "@/features/llm-provider/model/llm-provider";
import { SettingsSectionPanel } from "@/features/settings/components/settings-section-panel";
import { ApiError } from "@/shared/errors/api-error";
import "./provider-settings.css";

type LlmProviderSettingsView = "list" | "credential-create" | "credential-edit" | "custom-create" | "custom-edit";

const apiKeyInputClass =
	"h-10 w-full rounded-lg border border-[var(--line)] bg-white px-3 font-mono text-[11px] text-zinc-800 outline-none transition focus:border-[#7aa48e] focus:ring-2 focus:ring-[#397b5c]/10";

function initials(name: string): string {
	return name
		.split(/\s+/)
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

function authLabel(intl: IntlShape, provider: LlmProvider): string {
	if (provider.auth.apiKey && provider.auth.oauth) return "API Key · OAuth";
	if (provider.auth.apiKey) return "API Key";
	if (provider.auth.oauth) return "OAuth";
	return intl.formatMessage({ id: "provider.auth.noneAvailable" });
}

export function LlmProviderSettings({
	onClose,
	onBusyChange,
}: {
	onClose(): void;
	onBusyChange(busy: boolean): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const { providers, loading, error: providersError, refreshProviders } = useLlmProviders();
	const [view, setView] = useState<LlmProviderSettingsView>("list");
	const [listTab, setListTab] = useState<ProviderListTab>("connections");
	const [selectedProviderId, setSelectedProviderId] = useState("");
	const [selectedCustomProvider, setSelectedCustomProvider] = useState<CustomLlmProvider | null>(null);
	const [customProviders, setCustomProviders] = useState<readonly CustomLlmProvider[] | null>(null);
	const [customLoading, setCustomLoading] = useState(false);
	const [customError, setCustomError] = useState<unknown>(null);
	const [customBusy, setCustomBusy] = useState(false);
	const [navigationBusy, setNavigationBusy] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [fieldError, setFieldError] = useState<string | null>(null);
	const [conflictCredential, setConflictCredential] = useState<LlmProviderCredential | null>(null);
	const busy = submitting || deleting || customBusy || navigationBusy;
	const providerState = deriveLlmProviderState((providers ?? []).filter((provider) => provider.id !== "openai-chatgpt"));
	const selectedProvider = providers?.find((provider) => provider.id === selectedProviderId) ?? null;
	const currentCredential = conflictCredential ?? selectedProvider?.credential ?? null;

	const refreshCustomProviders = useCallback(async (): Promise<readonly CustomLlmProvider[]> => {
		setCustomLoading(true);
		setCustomError(null);
		try {
			const response = await llmProviderApi.listCustomProviders();
			setCustomProviders(response.providers);
			return response.providers;
		} catch (requestError) {
			setCustomError(requestError);
			throw requestError;
		} finally {
			setCustomLoading(false);
		}
	}, []);

	useEffect(() => {
		let active = true;
		const load = async () => {
			await Promise.resolve();
			if (!active) return;
			void refreshProviders().catch(() => undefined);
			void refreshCustomProviders().catch(() => undefined);
		};
		void load();
		return () => {
			active = false;
		};
	}, [refreshCustomProviders, refreshProviders]);

	useEffect(() => {
		onBusyChange(busy);
	}, [busy, onBusyChange]);

	useEffect(() => () => onBusyChange(false), [onBusyChange]);

	const clearSecret = () => {
		setApiKey("");
		setFieldError(null);
	};

	const returnToList = () => {
		clearSecret();
		setView("list");
		setSelectedProviderId("");
		setSelectedCustomProvider(null);
		setDeleteConfirm(false);
		setConflictCredential(null);
		setLocalError(null);
	};

	const startCredentialCreate = async (providerId = "") => {
		if (busy) return;
		setNavigationBusy(true);
		setLocalError(null);
		try {
			await refreshProviders();
			setView("credential-create");
			setSelectedProviderId(providerId);
			setConflictCredential(null);
			clearSecret();
		} catch (requestError) {
			setLocalError(localizedErrorMessage(requestError));
		} finally {
			setNavigationBusy(false);
		}
	};

	const startCredentialEdit = (provider: LlmProvider) => {
		setView("credential-edit");
		setSelectedProviderId(provider.id);
		setDeleteConfirm(false);
		setConflictCredential(null);
		setLocalError(null);
		clearSecret();
	};

	const startCustomEdit = async (providerId: string) => {
		if (busy) return;
		setNavigationBusy(true);
		setCustomLoading(true);
		setLocalError(null);
		try {
			const provider = await llmProviderApi.getCustomProvider(providerId);
			setSelectedCustomProvider(provider);
			setView("custom-edit");
		} catch (requestError) {
			setLocalError(localizedErrorMessage(requestError));
			void refreshCustomProviders().catch(() => undefined);
		} finally {
			setCustomLoading(false);
			setNavigationBusy(false);
		}
	};

	const finishCustomSave = async (provider: CustomLlmProvider) => {
		const [availableProviders] = await Promise.all([refreshProviders(), refreshCustomProviders()]);
		const catalogProvider = availableProviders.find((entry) => entry.id === provider.id);
		if (provider.authMode === "api_key" && catalogProvider?.credential === null) {
			setSelectedProviderId(provider.id);
			setSelectedCustomProvider(null);
			clearSecret();
			setView("credential-create");
			return;
		}
		returnToList();
	};

	const synchronizeConflict = async (providerId: string, action: "update" | "delete") => {
		try {
			const latest = await llmProviderApi.getCredential(providerId);
			setConflictCredential(latest);
			setLocalError(intl.formatMessage(
				{ id: "provider.credential.conflict" },
				{
					revision: latest.revision,
					action: intl.formatMessage({
						id: action === "update" ? "provider.credential.action.update" : "provider.credential.action.delete",
					}),
				},
			));
		} catch (requestError) {
			setLocalError(localizedErrorMessage(requestError));
			if (requestError instanceof ApiError && requestError.code === "not_found") returnToList();
		} finally {
			void refreshProviders().catch(() => undefined);
		}
	};

	const submitCredential = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const normalizedApiKey = apiKey.trim();
		if (!selectedProvider || normalizedApiKey.length === 0 || busy) {
			if (normalizedApiKey.length === 0) {
				setFieldError(intl.formatMessage({ id: "provider.credential.apiKeyRequired" }));
			}
			return;
		}
		setSubmitting(true);
		setFieldError(null);
		setLocalError(null);
		try {
			await llmProviderApi.configureCredential(
				selectedProvider.id,
				normalizedApiKey,
				view === "credential-edit" ? currentCredential?.revision : undefined,
			);
			clearSecret();
			await refreshProviders();
			returnToList();
		} catch (requestError) {
			if (requestError instanceof ApiError && requestError.code === "revision_conflict") {
				await synchronizeConflict(selectedProvider.id, "update");
			} else if (requestError instanceof ApiError && requestError.code === "not_found") {
				await refreshProviders().catch(() => undefined);
				returnToList();
			} else if (
				requestError instanceof ApiError
				&& requestError.code === "validation_error"
				&& requestError.field === "apiKey"
			) {
				setFieldError(requestError.message);
			} else {
				setLocalError(localizedErrorMessage(requestError));
			}
		} finally {
			setSubmitting(false);
		}
	};

	const deleteCredential = async () => {
		if (!selectedProvider || !currentCredential || deleting) return;
		setDeleting(true);
		setLocalError(null);
		try {
			await llmProviderApi.deleteCredential(selectedProvider.id, currentCredential.revision);
			clearSecret();
			await refreshProviders();
			returnToList();
		} catch (requestError) {
			setDeleteConfirm(false);
			if (requestError instanceof ApiError && requestError.code === "revision_conflict") {
				await synchronizeConflict(selectedProvider.id, "delete");
			} else if (requestError instanceof ApiError && requestError.code === "not_found") {
				await refreshProviders().catch(() => undefined);
				returnToList();
			} else {
				setLocalError(localizedErrorMessage(requestError));
			}
		} finally {
			setDeleting(false);
		}
	};

	const providerOptions: CustomSelectOption[] = providerState.configurableProviders
		.filter((provider) => listTab === "custom" ? provider.id === selectedProviderId : !provider.custom)
		.map((provider) => ({
		value: provider.id,
		label: provider.name,
		description: provider.auth.apiKey
			? `${intl.formatMessage({ id: provider.custom ? "provider.custom.badge" : "provider.builtin.badge" })} · ${provider.id} · ${intl.formatMessage({ id: "provider.models.count" }, { count: provider.modelCount })}`
			: `${provider.id} · ${intl.formatMessage({ id: provider.auth.oauth ? "provider.auth.oauthOnly" : "provider.auth.none" })}`,
		disabled: !provider.auth.apiKey,
	}));
	const title = view === "list"
		? intl.formatMessage({ id: "provider.title" })
		: view === "credential-create"
			? intl.formatMessage({ id: "provider.credential.configure" })
			: view === "credential-edit"
				? intl.formatMessage({ id: "provider.credential.update" }, { name: selectedProvider?.name ?? "Provider" })
				: view === "custom-create"
					? intl.formatMessage({ id: "provider.custom.add" })
					: intl.formatMessage({ id: "provider.custom.edit" }, {
						name: selectedCustomProvider?.name ?? intl.formatMessage({ id: "provider.custom.title" }),
					});
	const description = view === "list"
		? intl.formatMessage({ id: "provider.connections.description" })
		: view === "custom-create" || view === "custom-edit"
			? intl.formatMessage({ id: "provider.custom.form.description" })
			: intl.formatMessage({ id: "provider.credential.description" });

	return (
		<SettingsSectionPanel
			title={title}
			description={description}
			closeDisabled={busy}
			onBack={view === "list" ? undefined : returnToList}
			onClose={onClose}
		>
			{localError ? (
				<p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-5 text-rose-700" role="alert">
					{localError}
				</p>
			) : null}

			{view === "list" ? (
				<ProviderList
					activeTab={listTab}
					onTabChange={setListTab}
					busy={busy}
					subscription={providers?.some((provider) => provider.id === "openai-chatgpt") ? <ChatGptConnection disabled={navigationBusy} onBusyChange={setCustomBusy} /> : null}
					providers={providers}
					providersError={providersError}
					providerState={providerState}
					loading={loading}
					customProviders={customProviders}
					customError={customError}
					customLoading={customLoading}
					onReloadProviders={() => void refreshProviders().catch(() => undefined)}
					onReloadCustomProviders={() => void refreshCustomProviders().catch(() => undefined)}
					onCreateCustom={() => {
						setSelectedCustomProvider(null);
						setLocalError(null);
						setView("custom-create");
					}}
					onEditCustom={(providerId) => void startCustomEdit(providerId)}
					onCreateCredential={(providerId) => void startCredentialCreate(providerId)}
					onEditCredential={startCredentialEdit}
				/>
			) : view === "custom-create" || view === "custom-edit" ? (
				<CustomProviderEditor
					key={`${view}:${selectedCustomProvider?.id ?? "new"}`}
					provider={view === "custom-edit" ? selectedCustomProvider : null}
					onCancel={returnToList}
					onSaved={finishCustomSave}
					onDeleted={async () => {
						await Promise.all([refreshProviders(), refreshCustomProviders()]);
						returnToList();
					}}
					onBusyChange={setCustomBusy}
				/>
			) : (
				<CredentialForm
					view={view}
					busy={busy}
					loading={loading}
					deleting={deleting}
					submitting={submitting}
					deleteConfirm={deleteConfirm}
					conflictCredential={conflictCredential}
					selectedProvider={selectedProvider}
					selectedProviderId={selectedProviderId}
					providerOptions={providerOptions}
					apiKey={apiKey}
					fieldError={fieldError}
					onSelectedProviderIdChange={(value) => {
						setSelectedProviderId(value);
						setLocalError(null);
					}}
					onApiKeyChange={(value) => {
						setApiKey(value);
						setFieldError(null);
					}}
					onDeleteConfirmChange={setDeleteConfirm}
					onDelete={() => void deleteCredential()}
					onCancel={returnToList}
					onSubmit={(event) => void submitCredential(event)}
				/>
			)}
		</SettingsSectionPanel>
	);
}

function CredentialForm({
	view,
	busy,
	loading,
	deleting,
	submitting,
	deleteConfirm,
	conflictCredential,
	selectedProvider,
	selectedProviderId,
	providerOptions,
	apiKey,
	fieldError,
	onSelectedProviderIdChange,
	onApiKeyChange,
	onDeleteConfirmChange,
	onDelete,
	onCancel,
	onSubmit,
}: {
	view: "credential-create" | "credential-edit";
	busy: boolean;
	loading: boolean;
	deleting: boolean;
	submitting: boolean;
	deleteConfirm: boolean;
	conflictCredential: LlmProviderCredential | null;
	selectedProvider: LlmProvider | null;
	selectedProviderId: string;
	providerOptions: CustomSelectOption[];
	apiKey: string;
	fieldError: string | null;
	onSelectedProviderIdChange(value: string): void;
	onApiKeyChange(value: string): void;
	onDeleteConfirmChange(value: boolean): void;
	onDelete(): void;
	onCancel(): void;
	onSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
	const intl = useIntl();
	return (
		<form className="space-y-5" onSubmit={onSubmit}>
			{view === "credential-create" ? (
				<label className="block">
					<span className="mb-1.5 block text-[10px] font-medium text-zinc-600">Provider</span>
					<CustomSelect ariaLabel={intl.formatMessage({ id: "provider.credential.select" })} value={selectedProviderId} options={providerOptions} placeholder={intl.formatMessage({ id: loading ? "provider.selector.loading" : "provider.credential.select.placeholder" })} disabled={loading || busy} onChange={onSelectedProviderIdChange} />
					<span className="mt-1.5 block text-[9px] text-zinc-400">{intl.formatMessage({ id: "provider.credential.select.hint" })}</span>
				</label>
			) : null}

			{selectedProvider ? (
				<div className="rounded-xl border border-[var(--line-soft)] bg-[#fafaf8] px-4 py-4">
					<div className="flex items-center gap-3">
						<span className="grid h-9 w-9 place-items-center rounded-xl border border-[#d3e2d8] bg-[#edf4f0] text-[9px] font-bold text-[#397b5c]">{initials(selectedProvider.name)}</span>
						<div className="min-w-0"><p className="text-[11px] font-semibold text-zinc-800">{selectedProvider.name}</p><p className="mt-1 font-mono text-[8px] text-zinc-400">{selectedProvider.id}</p></div>
					</div>
					<dl className="mt-4 grid gap-3 border-t border-zinc-200/70 pt-4 sm:grid-cols-3">
						<div><dt className="text-[8px] font-semibold uppercase tracking-[0.08em] text-zinc-400">Endpoint</dt><dd className="mt-1.5 break-all font-mono text-[9px] leading-4 text-zinc-600">{selectedProvider.baseUrl ?? intl.formatMessage({ id: "provider.credential.endpoint.runtime" })}</dd></div>
						<div><dt className="text-[8px] font-semibold uppercase tracking-[0.08em] text-zinc-400">{intl.formatMessage({ id: "provider.custom.field.auth" })}</dt><dd className="mt-1.5 text-[9px] text-zinc-600">{authLabel(intl, selectedProvider)}</dd></div>
						<div><dt className="text-[8px] font-semibold uppercase tracking-[0.08em] text-zinc-400">{intl.formatMessage({ id: "provider.custom.field.catalog" })}</dt><dd className="mt-1.5 text-[9px] text-zinc-600">{intl.formatMessage({ id: "provider.models.count" }, { count: selectedProvider.modelCount })}</dd></div>
					</dl>
				</div>
			) : null}

			<label className="block">
				<span className="mb-1.5 block text-[10px] font-medium text-zinc-600">API Key</span>
				<input type="password" className={apiKeyInputClass} value={apiKey} maxLength={65_536} autoComplete="new-password" disabled={busy || !selectedProvider} onChange={(event) => onApiKeyChange(event.target.value)} placeholder={intl.formatMessage({ id: view === "credential-edit" ? "provider.credential.apiKey.new" : "provider.credential.apiKey.input" })} />
				{fieldError ? <span className="mt-1.5 block text-[9px] text-rose-600" role="alert">{fieldError}</span> : <span className="mt-1.5 block text-[9px] text-zinc-400">{intl.formatMessage({ id: "provider.credential.apiKey.hint" })}</span>}
			</label>

			<div className="flex items-center justify-between gap-3 border-t border-[var(--line-soft)] pt-5">
				<div>
					{view === "credential-edit" ? deleteConfirm ? (
						<span className="inline-flex items-center gap-2">
							<span className="text-[9px] text-rose-600">{intl.formatMessage({ id: "provider.credential.delete.confirm" })}</span>
							<button type="button" className="h-8 rounded-lg bg-rose-600 px-3 text-[9px] font-semibold text-white disabled:opacity-45" disabled={busy} onClick={onDelete}>{intl.formatMessage({ id: deleting ? "provider.custom.delete.deleting" : "provider.custom.delete.confirm" })}</button>
							<button type="button" className="h-8 px-2 text-[9px] font-semibold text-zinc-500" disabled={busy} onClick={() => onDeleteConfirmChange(false)}>{intl.formatMessage({ id: "common.cancel" })}</button>
						</span>
					) : (
						<button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[9px] font-semibold text-rose-600 hover:bg-rose-50" disabled={busy} onClick={() => onDeleteConfirmChange(true)}><Trash2 size={12} /> {intl.formatMessage({ id: "provider.credential.delete" })}</button>
					) : null}
				</div>
				<div className="flex items-center gap-2">
					<button type="button" className="h-9 rounded-lg border border-[var(--line)] px-4 text-[9px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-45" disabled={busy} onClick={onCancel}>{intl.formatMessage({ id: "common.cancel" })}</button>
					<button type="submit" className="h-9 rounded-lg bg-[#397b5c] px-4 text-[9px] font-semibold text-white shadow-sm transition hover:bg-[#326e52] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !selectedProvider || apiKey.trim().length === 0}>{intl.formatMessage({ id: submitting ? "common.saving" : conflictCredential ? "provider.custom.overwrite" : view === "credential-create" ? "provider.credential.add" : "provider.credential.apiKey.update" })}</button>
				</div>
			</div>
		</form>
	);
}
