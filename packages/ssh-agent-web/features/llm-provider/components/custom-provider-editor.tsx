"use client";

import { Download, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { CustomSelect, type CustomSelectOption } from "@/components/custom-select";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { llmProviderApi } from "@/features/llm-provider/api/llm-provider-api";
import {
	type CreateCustomLlmProviderInput,
	type CustomLlmModel,
	type CustomLlmProvider,
	type CustomLlmProviderApi,
	type CustomLlmProviderAuthMode,
} from "@/features/llm-provider/model/llm-provider";
import {
	CustomProviderModelDiscoveryError,
	defaultModelsEndpoint,
	discoverCustomProviderModels,
} from "@/features/llm-provider/model/custom-provider-model-discovery";
import { ApiError } from "@/shared/errors/api-error";

const inputClass =
	"h-10 w-full rounded-lg border border-[var(--line)] bg-white px-3 text-[10px] text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-[#7aa48e] focus:ring-2 focus:ring-[#397b5c]/10 disabled:bg-zinc-50 disabled:text-zinc-500";
const numberInputClass = `${inputClass} font-mono`;

const apiOptions: CustomSelectOption[] = [
	{ value: "openai-completions", label: "OpenAI Completions" },
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "anthropic-messages", label: "Anthropic Messages" },
	{ value: "google-generative-ai", label: "Google Generative AI" },
];

interface ModelDraft {
	id: string;
	name: string;
	reasoning: boolean;
	textInput: boolean;
	imageInput: boolean;
	contextWindow: string;
	maxTokens: string;
	cost: CustomLlmModel["cost"];
}

function emptyModel(): ModelDraft {
	return {
		id: "",
		name: "",
		reasoning: false,
		textInput: true,
		imageInput: false,
		contextWindow: "128000",
		maxTokens: "8192",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function modelDraft(model: CustomLlmModel): ModelDraft {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		textInput: model.input.includes("text"),
		imageInput: model.input.includes("image"),
		contextWindow: String(model.contextWindow),
		maxTokens: String(model.maxTokens),
		cost: model.cost,
	};
}

function toPositiveInteger(value: string): number | null {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function CustomProviderEditor({
	provider,
	onCancel,
	onSaved,
	onDeleted,
	onBusyChange,
}: {
	provider: CustomLlmProvider | null;
	onCancel(): void;
	onSaved(provider: CustomLlmProvider): Promise<void>;
	onDeleted(): Promise<void>;
	onBusyChange(busy: boolean): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const editing = provider !== null;
	const [id, setId] = useState(provider?.id ?? "custom-");
	const [name, setName] = useState(provider?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
	const [api, setApi] = useState<CustomLlmProviderApi>(provider?.api ?? "openai-completions");
	const [authMode, setAuthMode] = useState<CustomLlmProviderAuthMode>(provider?.authMode ?? "api_key");
	const [apiKey, setApiKey] = useState("");
	const [modelsEndpoint, setModelsEndpoint] = useState(() => defaultModelsEndpoint(provider?.baseUrl ?? ""));
	const [modelsEndpointCustomized, setModelsEndpointCustomized] = useState(false);
	const [models, setModels] = useState<ModelDraft[]>(provider?.models.map(modelDraft) ?? [emptyModel()]);
	const [discovering, setDiscovering] = useState(false);
	const [localizedDiscoveryMessage, setLocalizedDiscoveryMessage] = useState<{ locale: string; type: "error" | "success"; text: string } | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [localizedFormError, setLocalizedFormError] = useState<{ locale: string; text: string } | null>(null);
	const [conflictRevision, setConflictRevision] = useState<number | null>(null);
	const busy = submitting || deleting || discovering;
	const normalizedId = id.trim();
	const normalizedName = name.trim();
	const normalizedBaseUrl = baseUrl.trim();
	const normalizedApiKey = apiKey.trim();
	const canSubmit = normalizedId.length > 0 && normalizedName.length > 0 && normalizedBaseUrl.length > 0;
	const compatibility = useMemo(() => provider?.api === api ? provider.compat : {}, [api, provider]);
	const authOptions = useMemo<CustomSelectOption[]>(() => [
		{ value: "api_key", label: "API Key" },
		{ value: "none", label: intl.formatMessage({ id: "provider.auth.none" }) },
	], [intl]);

	const formError = localizedFormError?.locale === intl.locale ? localizedFormError.text : null;
	const discoveryMessage = localizedDiscoveryMessage?.locale === intl.locale ? localizedDiscoveryMessage : null;
	const setFormError = (message: string | null) => {
		setLocalizedFormError(message === null ? null : { locale: intl.locale, text: message });
	};
	const setDiscoveryMessage = (message: { type: "error" | "success"; text: string } | null) => {
		setLocalizedDiscoveryMessage(message === null ? null : { ...message, locale: intl.locale });
	};

	const updateModel = (index: number, update: Partial<ModelDraft>) => {
		setModels((current) => current.map((model, modelIndex) => modelIndex === index ? { ...model, ...update } : model));
		setFormError(null);
	};

	const buildInput = (): CreateCustomLlmProviderInput | null => {
		if (!/^custom-[a-z0-9][a-z0-9._-]*$/.test(normalizedId)) {
			setFormError(intl.formatMessage({ id: "provider.custom.validation.id" }));
			return null;
		}
		try {
			const url = new URL(normalizedBaseUrl);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
		} catch {
			setFormError(intl.formatMessage({ id: "provider.custom.validation.endpoint" }));
			return null;
		}
		const modelIds = new Set<string>();
		const normalizedModels: CustomLlmModel[] = [];
		for (const [index, model] of models.entries()) {
			const modelId = model.id.trim();
			const modelName = model.name.trim();
			const contextWindow = toPositiveInteger(model.contextWindow);
			const maxTokens = toPositiveInteger(model.maxTokens);
			if (!modelId || !modelName) {
				setFormError(intl.formatMessage({ id: "provider.custom.validation.modelRequired" }, { index: index + 1 }));
				return null;
			}
			if (modelIds.has(modelId)) {
				setFormError(intl.formatMessage({ id: "provider.custom.validation.modelDuplicate" }, { modelId }));
				return null;
			}
			if (contextWindow === null || maxTokens === null) {
				setFormError(intl.formatMessage({ id: "provider.custom.validation.modelIntegers" }, { index: index + 1 }));
				return null;
			}
			if (maxTokens > contextWindow) {
				setFormError(intl.formatMessage({ id: "provider.custom.validation.maxTokens" }, { index: index + 1 }));
				return null;
			}
			const input = [
				...(model.textInput ? ["text" as const] : []),
				...(model.imageInput ? ["image" as const] : []),
			];
			if (input.length === 0) {
				setFormError(intl.formatMessage({ id: "provider.custom.validation.input" }, { index: index + 1 }));
				return null;
			}
			modelIds.add(modelId);
			normalizedModels.push({
				id: modelId,
				name: modelName,
				reasoning: model.reasoning,
				input,
				cost: model.cost,
				contextWindow,
				maxTokens,
			});
		}
		return {
			id: normalizedId,
			name: normalizedName,
			baseUrl: normalizedBaseUrl,
			api,
			authMode,
			compat: compatibility,
			models: normalizedModels,
			...(!editing && authMode === "api_key" && normalizedApiKey
				? { credential: { type: "api_key" as const, apiKey: normalizedApiKey } }
				: {}),
		};
	};

	const discoverModels = async () => {
		if (busy) return;
		if (!normalizedApiKey) {
			setDiscoveryMessage({ type: "error", text: intl.formatMessage({ id: "provider.discovery.apiKeyRequired" }) });
			return;
		}
		if (!modelsEndpoint.trim()) {
			setDiscoveryMessage({ type: "error", text: intl.formatMessage({ id: "provider.discovery.endpointRequired" }) });
			return;
		}
		setDiscovering(true);
		onBusyChange(true);
		setDiscoveryMessage(null);
		try {
			const discoveredModels = await discoverCustomProviderModels({
				endpoint: modelsEndpoint,
				api,
				apiKey,
			});
			if (discoveredModels.length === 0) {
				setDiscoveryMessage({ type: "error", text: intl.formatMessage({ id: "provider.discovery.empty" }) });
				return;
			}
			setModels((current) => {
				const currentById = new Map(current.map((model) => [model.id.trim(), model]));
				return discoveredModels.map((model) => {
					const existing = currentById.get(model.id);
					return existing
						? { ...existing, name: existing.name.trim() || model.name }
						: { ...emptyModel(), id: model.id, name: model.name };
				});
			});
			setDiscoveryMessage({ type: "success", text: intl.formatMessage({ id: "provider.discovery.success" }, { count: discoveredModels.length }) });
		} catch (requestError) {
			const text = requestError instanceof CustomProviderModelDiscoveryError
				? requestError.code === "invalid_endpoint"
					? intl.formatMessage({ id: "provider.discovery.invalidEndpoint" })
					: requestError.code === "api_key_required"
						? intl.formatMessage({ id: "provider.discovery.apiKeyRequired" })
						: requestError.code === "request_failed"
							? intl.formatMessage({ id: "provider.discovery.requestFailed" }, { status: requestError.status ?? 0 })
							: intl.formatMessage({ id: "provider.discovery.invalidResponse" })
				: intl.formatMessage({ id: "provider.discovery.failed" });
			setDiscoveryMessage({
				type: "error",
				text,
			});
		} finally {
			setDiscovering(false);
			onBusyChange(false);
		}
	};

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (busy) return;
		const input = buildInput();
		if (!input) return;
		setSubmitting(true);
		onBusyChange(true);
		setFormError(null);
		try {
			const saved = editing
				? await llmProviderApi.updateCustomProvider(provider.id, {
					name: input.name,
					baseUrl: input.baseUrl,
					api: input.api,
					authMode: input.authMode,
					compat: input.compat,
					models: input.models,
					expectedRevision: conflictRevision ?? provider.revision,
				})
				: await llmProviderApi.createCustomProvider(input);
			if (!editing) setApiKey("");
			await onSaved(saved);
		} catch (requestError) {
			if (editing && requestError instanceof ApiError && requestError.code === "revision_conflict") {
				try {
					const latest = await llmProviderApi.getCustomProvider(provider.id);
					setConflictRevision(latest.revision);
					setFormError(intl.formatMessage({ id: "provider.custom.conflict.save" }, { revision: latest.revision }));
				} catch (refreshError) {
					setFormError(localizedErrorMessage(refreshError));
				}
			} else if (requestError instanceof ApiError && requestError.code === "validation_error") {
				setFormError(requestError.message);
			} else {
				setFormError(localizedErrorMessage(requestError));
			}
		} finally {
			setSubmitting(false);
			onBusyChange(false);
		}
	};

	const remove = async () => {
		if (!provider || deleting) return;
		setDeleting(true);
		onBusyChange(true);
		setFormError(null);
		try {
			await llmProviderApi.deleteCustomProvider(provider.id, conflictRevision ?? provider.revision);
			await onDeleted();
		} catch (requestError) {
			setDeleteConfirm(false);
			if (requestError instanceof ApiError && requestError.code === "revision_conflict") {
				try {
					const latest = await llmProviderApi.getCustomProvider(provider.id);
					setConflictRevision(latest.revision);
					setFormError(intl.formatMessage({ id: "provider.custom.conflict.delete" }, { revision: latest.revision }));
				} catch (refreshError) {
					setFormError(localizedErrorMessage(refreshError));
				}
			} else {
				setFormError(localizedErrorMessage(requestError));
			}
		} finally {
			setDeleting(false);
			onBusyChange(false);
		}
	};

	return (
		<form className="space-y-5" onSubmit={(event) => void submit(event)}>
			{formError ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-5 text-rose-700" role="alert">{formError}</p> : null}

			<div className="grid gap-4 sm:grid-cols-2">
				<label className="block"><span className="mb-1.5 block text-[10px] font-medium text-zinc-600">Provider ID</span><input className={`${inputClass} font-mono`} value={id} maxLength={128} disabled={editing || busy} onChange={(event) => { setId(event.target.value.toLowerCase()); setFormError(null); }} placeholder="custom-company" /><span className="mt-1.5 block text-[8px] text-zinc-400">{intl.formatMessage({ id: "provider.custom.id.hint" })}</span></label>
				<label className="block"><span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "provider.custom.field.displayName" })}</span><input className={inputClass} value={name} maxLength={256} disabled={busy} onChange={(event) => { setName(event.target.value); setFormError(null); }} placeholder="Company LLM" /></label>
			</div>

			<label className="block"><span className="mb-1.5 block text-[10px] font-medium text-zinc-600">Endpoint</span><input className={`${inputClass} font-mono`} value={baseUrl} maxLength={2048} disabled={busy} onChange={(event) => { const nextBaseUrl = event.target.value; setBaseUrl(nextBaseUrl); if (!modelsEndpointCustomized) setModelsEndpoint(defaultModelsEndpoint(nextBaseUrl)); setFormError(null); setDiscoveryMessage(null); }} placeholder="https://api.example.com/v1" /><span className="mt-1.5 block text-[8px] text-zinc-400">{intl.formatMessage({ id: "provider.custom.endpoint.hint" })}</span></label>

			<div className="grid gap-4 sm:grid-cols-2">
				<label className="block"><span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "provider.custom.field.protocol" })}</span><CustomSelect ariaLabel={intl.formatMessage({ id: "provider.custom.field.protocol" })} value={api} options={apiOptions} disabled={busy} onChange={(value) => { setApi(value as CustomLlmProviderApi); setFormError(null); }} /></label>
				<label className="block"><span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{intl.formatMessage({ id: "provider.custom.field.auth" })}</span><CustomSelect ariaLabel={intl.formatMessage({ id: "provider.custom.field.auth" })} value={authMode} options={authOptions} disabled={busy} onChange={(value) => { const nextAuthMode = value as CustomLlmProviderAuthMode; setAuthMode(nextAuthMode); if (nextAuthMode === "none") setApiKey(""); setFormError(null); }} /><span className="mt-1.5 block text-[8px] text-zinc-400">{intl.formatMessage({ id: editing ? "provider.custom.auth.editHint" : "provider.custom.auth.createHint" })}</span></label>
			</div>

			<label className="block">
				<span className="mb-1.5 block text-[10px] font-medium text-zinc-600">{editing || authMode === "none" ? intl.formatMessage({ id: "provider.custom.field.modelsApiKey" }) : "API Key"} <span className="font-normal text-zinc-400">{intl.formatMessage({ id: "provider.custom.field.discoveryRequired" })}</span></span>
				<input
					type="password"
					className={`${inputClass} font-mono`}
					value={apiKey}
					maxLength={65_536}
					autoComplete="new-password"
					disabled={busy}
					onChange={(event) => { setApiKey(event.target.value); setFormError(null); setDiscoveryMessage(null); }}
					placeholder="sk-..."
				/>
				<span className="mt-1.5 block text-[8px] text-zinc-400">{intl.formatMessage({ id: !editing && authMode === "api_key" ? "provider.custom.apiKey.createHint" : "provider.custom.apiKey.discoveryHint" })}</span>
			</label>

			<section className="rounded-2xl border border-[var(--line-soft)] bg-[#fafaf8] p-4">
				<div className="flex items-center justify-between gap-4"><div><h3 className="text-[11px] font-semibold text-zinc-800">{intl.formatMessage({ id: "provider.custom.field.catalog" })}</h3><p className="mt-1 text-[8px] text-zinc-400">{intl.formatMessage({ id: "provider.custom.catalog.description" })}</p></div><button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-3 text-[9px] font-semibold text-[#397b5c] transition hover:border-[#b9cec0]" disabled={busy} onClick={() => setModels((current) => [...current, emptyModel()])}><Plus size={12} /> {intl.formatMessage({ id: "provider.custom.catalog.add" })}</button></div>

				<div className="mt-4 rounded-xl border border-zinc-200 bg-white p-3.5">
					<div className="flex items-end gap-2">
						<label className="min-w-0 flex-1">
							<span className="mb-1 block text-[8px] text-zinc-500">{intl.formatMessage({ id: "provider.custom.field.catalogEndpoint" })}</span>
							<input className={`${inputClass} font-mono`} value={modelsEndpoint} maxLength={2048} disabled={busy} onChange={(event) => { setModelsEndpoint(event.target.value); setModelsEndpointCustomized(true); setDiscoveryMessage(null); }} placeholder="https://api.example.com/models" />
						</label>
						<button type="button" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-3 text-[9px] font-semibold text-zinc-600 transition hover:border-[#b9cec0] hover:text-[#397b5c] disabled:opacity-45" disabled={busy || !defaultModelsEndpoint(baseUrl)} onClick={() => { setModelsEndpoint(defaultModelsEndpoint(baseUrl)); setModelsEndpointCustomized(false); setDiscoveryMessage(null); }} title={intl.formatMessage({ id: "provider.custom.catalog.restoreDefault" })}><RotateCcw size={12} /> {intl.formatMessage({ id: "provider.custom.catalog.default" })}</button>
						<button type="button" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-[#397b5c] px-3 text-[9px] font-semibold text-white transition hover:bg-[#326e52] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !modelsEndpoint.trim() || !normalizedApiKey} onClick={() => void discoverModels()}><Download size={12} /> {intl.formatMessage({ id: discovering ? "provider.custom.catalog.fetching" : "provider.custom.catalog.fetch" })}</button>
					</div>
					<p className="mt-1.5 text-[8px] text-zinc-400">{intl.formatMessage({ id: "provider.custom.catalog.endpointHint" })}</p>
					{discoveryMessage ? <p className={`mt-2 text-[9px] ${discoveryMessage.type === "error" ? "text-rose-600" : "text-[#397b5c]"}`} role={discoveryMessage.type === "error" ? "alert" : "status"}>{discoveryMessage.text}</p> : null}
				</div>

				{models.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-center text-[9px] text-zinc-400">{intl.formatMessage({ id: "provider.custom.catalog.empty" })}</p> : null}
				<div className="mt-4 space-y-3">
					{models.map((model, index) => (
						<div key={index} className="rounded-xl border border-zinc-200 bg-white p-3.5">
							<div className="flex items-center justify-between gap-3"><p className="text-[9px] font-semibold text-zinc-600">{intl.formatMessage({ id: "provider.custom.catalog.item" }, { index: index + 1 })}</p><button type="button" className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600" disabled={busy} onClick={() => setModels((current) => current.filter((_, modelIndex) => modelIndex !== index))} aria-label={intl.formatMessage({ id: "provider.custom.catalog.remove" }, { index: index + 1 })}><Trash2 size={12} /></button></div>
							<div className="mt-3 grid gap-3 sm:grid-cols-2"><label><span className="mb-1 block text-[8px] text-zinc-500">{intl.formatMessage({ id: "provider.custom.field.modelId" })}</span><input className={`${inputClass} font-mono`} value={model.id} maxLength={256} disabled={busy} onChange={(event) => updateModel(index, { id: event.target.value })} placeholder="model-id" /></label><label><span className="mb-1 block text-[8px] text-zinc-500">{intl.formatMessage({ id: "provider.custom.field.modelName" })}</span><input className={inputClass} value={model.name} maxLength={256} disabled={busy} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder="Model Name" /></label></div>
							<div className="mt-3 grid gap-3 sm:grid-cols-2"><label><span className="mb-1 block text-[8px] text-zinc-500">{intl.formatMessage({ id: "provider.custom.field.contextWindow" })}</span><input type="number" min={1} step={1} className={numberInputClass} value={model.contextWindow} disabled={busy} onChange={(event) => updateModel(index, { contextWindow: event.target.value })} /></label><label><span className="mb-1 block text-[8px] text-zinc-500">{intl.formatMessage({ id: "provider.custom.field.maxTokens" })}</span><input type="number" min={1} step={1} className={numberInputClass} value={model.maxTokens} disabled={busy} onChange={(event) => updateModel(index, { maxTokens: event.target.value })} /></label></div>
							<div className="mt-3 flex flex-wrap items-center gap-5 text-[9px] text-zinc-600"><label className="inline-flex items-center gap-2"><input type="checkbox" className="h-3.5 w-3.5 accent-[#397b5c]" checked={model.textInput} disabled={busy} onChange={(event) => updateModel(index, { textInput: event.target.checked })} />{intl.formatMessage({ id: "provider.custom.field.textInput" })}</label><label className="inline-flex items-center gap-2"><input type="checkbox" className="h-3.5 w-3.5 accent-[#397b5c]" checked={model.imageInput} disabled={busy} onChange={(event) => updateModel(index, { imageInput: event.target.checked })} />{intl.formatMessage({ id: "provider.custom.field.imageInput" })}</label><label className="inline-flex items-center gap-2"><input type="checkbox" className="h-3.5 w-3.5 accent-[#397b5c]" checked={model.reasoning} disabled={busy} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} />{intl.formatMessage({ id: "provider.custom.field.reasoning" })}</label></div>
						</div>
					))}
				</div>
			</section>

			<div className="flex items-center justify-between gap-3 border-t border-[var(--line-soft)] pt-5">
				<div>{editing ? deleteConfirm ? <span className="inline-flex items-center gap-2"><span className="text-[9px] text-rose-600">{intl.formatMessage({ id: "provider.custom.delete.description" })}</span><button type="button" className="h-8 rounded-lg bg-rose-600 px-3 text-[9px] font-semibold text-white disabled:opacity-45" disabled={busy} onClick={() => void remove()}>{intl.formatMessage({ id: deleting ? "provider.custom.delete.deleting" : "provider.custom.delete.confirm" })}</button><button type="button" className="h-8 px-2 text-[9px] font-semibold text-zinc-500" disabled={busy} onClick={() => setDeleteConfirm(false)}>{intl.formatMessage({ id: "common.cancel" })}</button></span> : <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[9px] font-semibold text-rose-600 hover:bg-rose-50" disabled={busy} onClick={() => setDeleteConfirm(true)}><Trash2 size={12} /> {intl.formatMessage({ id: "provider.custom.delete" })}</button> : null}</div>
				<div className="flex items-center gap-2"><button type="button" className="h-9 rounded-lg border border-[var(--line)] px-4 text-[9px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-45" disabled={busy} onClick={onCancel}>{intl.formatMessage({ id: "common.cancel" })}</button><button type="submit" className="h-9 rounded-lg bg-[#397b5c] px-4 text-[9px] font-semibold text-white shadow-sm transition hover:bg-[#326e52] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !canSubmit}>{intl.formatMessage({ id: submitting ? "common.saving" : conflictRevision ? "provider.custom.overwrite" : editing ? "provider.custom.save" : "provider.custom.create" })}</button></div>
			</div>
		</form>
	);
}
