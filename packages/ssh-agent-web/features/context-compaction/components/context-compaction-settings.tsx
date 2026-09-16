"use client";

import { Check, RefreshCw, Shrink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { contextCompactionSettingsApi } from "@/features/context-compaction/api/context-compaction-settings-api";
import {
	contextCompactionModelSelection,
	contextCompactionSettingsDraft,
	sameContextCompactionDraft,
	type ContextCompactionModelSelection,
	type ContextCompactionSettings as ContextCompactionSettingsValue,
	type ContextCompactionSettingsDraft,
} from "@/features/context-compaction/model/context-compaction-settings";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { resolveConfiguredModel } from "@/features/llm-provider/api/llm-provider-api";
import { ModelSelector } from "@/features/llm-provider/components/model-selector";
import type { LlmModel } from "@/features/llm-provider/model/llm-provider";
import { SettingsSectionPanel } from "@/features/settings/components/settings-section-panel";
import { ApiError } from "@/shared/errors/api-error";

type ModelResolution = "idle" | "loading" | "available" | "unavailable" | "failed";

export function ContextCompactionSettings({
	onClose,
	onBusyChange,
}: {
	onClose(): void;
	onBusyChange(busy: boolean): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const loadSequenceRef = useRef(0);
	const loadControllerRef = useRef<AbortController | null>(null);
	const saveControllerRef = useRef<AbortController | null>(null);
	const [settings, setSettings] = useState<ContextCompactionSettingsValue | null>(null);
	const [draft, setDraft] = useState<ContextCompactionSettingsDraft | null>(null);
	const [selectedModel, setSelectedModel] = useState<LlmModel | null>(null);
	const [modelResolution, setModelResolution] = useState<ModelResolution>("idle");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const resolveModel = useCallback(async (
		selection: ContextCompactionModelSelection | null,
		controller: AbortController,
		sequence: number,
	) => {
		setSelectedModel(null);
		if (selection === null) {
			setModelResolution("idle");
			return;
		}
		setModelResolution("loading");
		try {
			const model = await resolveConfiguredModel(selection, controller.signal);
			if (sequence !== loadSequenceRef.current || controller.signal.aborted) return;
			setSelectedModel(model);
			setModelResolution(model === null ? "unavailable" : "available");
		} catch {
			if (sequence !== loadSequenceRef.current || controller.signal.aborted) return;
			setModelResolution("failed");
		}
	}, []);

	const loadSettings = useCallback(async (preservedDraft?: ContextCompactionSettingsDraft): Promise<ContextCompactionSettingsValue | null> => {
		loadControllerRef.current?.abort();
		const controller = new AbortController();
		loadControllerRef.current = controller;
		const sequence = ++loadSequenceRef.current;
		setLoading(true);
		setLoadError(null);
		try {
			const nextSettings = await contextCompactionSettingsApi.get(controller.signal);
			if (sequence !== loadSequenceRef.current || controller.signal.aborted) return null;
			const nextDraft = preservedDraft ?? contextCompactionSettingsDraft(nextSettings);
			setSettings(nextSettings);
			setDraft(nextDraft);
			await resolveModel(nextDraft.model, controller, sequence);
			return sequence === loadSequenceRef.current && !controller.signal.aborted ? nextSettings : null;
		} catch (requestError) {
			if (sequence === loadSequenceRef.current && !controller.signal.aborted) setLoadError(requestError);
			return null;
		} finally {
			if (sequence === loadSequenceRef.current && !controller.signal.aborted) setLoading(false);
		}
	}, [resolveModel]);

	useEffect(() => {
		const loadTimer = window.setTimeout(() => void loadSettings(), 0);
		return () => {
			window.clearTimeout(loadTimer);
			loadControllerRef.current?.abort();
			const saveController = saveControllerRef.current;
			saveControllerRef.current = null;
			saveController?.abort();
		};
	}, [loadSettings]);

	useEffect(() => {
		onBusyChange(saving);
		return () => onBusyChange(false);
	}, [onBusyChange, saving]);

	const updateModel = (model: LlmModel | null) => {
		setDraft((current) => current === null ? null : {
			...current,
			model: model === null ? null : contextCompactionModelSelection(model),
		});
		setSelectedModel(model);
		setModelResolution(model === null ? "idle" : "available");
		setSaveError(null);
		setSaved(false);
	};

	const save = async () => {
		if (settings === null || draft === null || saving || sameContextCompactionDraft(settings, draft)) return;
		const controller = new AbortController();
		saveControllerRef.current = controller;
		setSaving(true);
		setSaveError(null);
		setSaved(false);
		try {
			const updated = await contextCompactionSettingsApi.update(draft, settings.revision, controller.signal);
			if (saveControllerRef.current !== controller || controller.signal.aborted) return;
			setSettings(updated);
			setDraft(contextCompactionSettingsDraft(updated));
			setSaved(true);
		} catch (requestError) {
			if (saveControllerRef.current !== controller || controller.signal.aborted) return;
			if (requestError instanceof ApiError && requestError.code === "revision_conflict") {
				const reloadedSettings = await loadSettings(draft);
				if (reloadedSettings !== null && sameContextCompactionDraft(reloadedSettings, draft)) {
					setSaved(true);
				} else if (reloadedSettings !== null) {
					setSaveError(intl.formatMessage({ id: "settings.compaction.conflict" }));
				} else {
					setSaveError(localizedErrorMessage(requestError));
				}
			} else {
				setSaveError(localizedErrorMessage(requestError));
			}
		} finally {
			if (saveControllerRef.current === controller) {
				saveControllerRef.current = null;
				setSaving(false);
			}
		}
	};

	const modelLabel = draft?.model === null
		? intl.formatMessage({ id: "settings.compaction.model.session" })
		: selectedModel?.name ?? `${draft?.model.providerId} / ${draft?.model.modelId}`;
	const dirty = settings !== null && draft !== null && !sameContextCompactionDraft(settings, draft);

	return (
		<SettingsSectionPanel
			title={intl.formatMessage({ id: "settings.compaction.title" })}
			description={intl.formatMessage({ id: "settings.compaction.description" })}
			closeDisabled={saving}
			onClose={onClose}
		>
			{loading && settings === null ? <LoadingState /> : null}
			{loadError && settings === null ? (
				<div className="grid min-h-64 place-items-center text-center">
					<div>
						<p className="max-w-sm text-[10px] leading-5 text-[var(--danger)]">{localizedErrorMessage(loadError)}</p>
						<button type="button" className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-semibold text-[var(--accent-ink)]" onClick={() => void loadSettings()}>
							<RefreshCw size={12} />{intl.formatMessage({ id: "common.reload" })}
						</button>
					</div>
				</div>
			) : null}

			{settings !== null && draft !== null ? (
				<div className="max-w-[640px] space-y-7">
					<section className="flex items-start gap-3 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-3.5">
						<span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-raised)] text-[var(--accent-ink)]"><Shrink size={15} /></span>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<p className="text-[11px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "settings.compaction.automatic.title" })}</p>
								<span className="rounded-full bg-[var(--surface-raised)] px-2 py-0.5 text-[8px] font-semibold text-[var(--accent-ink)]">{intl.formatMessage({ id: "settings.compaction.automatic.enabled" })}</span>
							</div>
							<p className="mt-1 text-[9px] leading-4 text-[var(--text-muted)]">{intl.formatMessage({ id: "settings.compaction.automatic.description" })}</p>
						</div>
					</section>

					<section className="space-y-4">
						<div className="flex items-end justify-between gap-4">
							<div>
								<p className="text-[12px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "settings.compaction.threshold.title" })}</p>
								<p className="mt-1.5 max-w-[500px] text-[10px] leading-5 text-[var(--text-muted)]">{intl.formatMessage({ id: "settings.compaction.threshold.description" })}</p>
							</div>
							<span className="shrink-0 font-mono text-[18px] font-semibold tabular-nums text-[var(--accent-ink)]">{draft.triggerPercent}%</span>
						</div>
						<input
							type="range"
							className="h-1.5 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
							min={1}
							max={99}
							step={1}
							value={draft.triggerPercent}
							disabled={saving}
							aria-label={intl.formatMessage({ id: "settings.compaction.threshold.title" })}
							onChange={(event) => {
								setDraft({ ...draft, triggerPercent: event.currentTarget.valueAsNumber });
								setSaveError(null);
								setSaved(false);
							}}
						/>
						<div className="flex justify-between font-mono text-[8px] text-[var(--text-faint)]"><span>1%</span><span>50%</span><span>99%</span></div>
					</section>

					<section className="border-t border-[var(--line-soft)] pt-6">
						<div className="flex flex-wrap items-start justify-between gap-4">
							<div className="max-w-[430px]">
								<p className="text-[12px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "settings.compaction.model.title" })}</p>
								<p className="mt-1.5 text-[10px] leading-5 text-[var(--text-muted)]">{intl.formatMessage({ id: "settings.compaction.model.description" })}</p>
							</div>
							<ModelSelector
								selectedModel={selectedModel}
								selectedNone={draft.model === null}
								noneOptionLabel={intl.formatMessage({ id: "settings.compaction.model.session" })}
								modelLabel={modelLabel}
								disabled={saving || modelResolution === "loading"}
								popoverLayer="settings-dialog"
								onSelect={updateModel}
							/>
						</div>
						{modelResolution === "loading" ? <p className="mt-3 text-[9px] text-[var(--text-muted)]">{intl.formatMessage({ id: "settings.compaction.model.loading" })}</p> : null}
						{modelResolution === "unavailable" ? <p className="mt-3 rounded-lg bg-[var(--warning-soft)] px-3 py-2 text-[9px] leading-4 text-[var(--warning)]">{intl.formatMessage({ id: "settings.compaction.model.unavailable" })}</p> : null}
						{modelResolution === "failed" ? <p className="mt-3 rounded-lg bg-[var(--warning-soft)] px-3 py-2 text-[9px] leading-4 text-[var(--warning)]">{intl.formatMessage({ id: "settings.compaction.model.loadFailed" })}</p> : null}
					</section>

					<footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--line-soft)] pt-5">
						<p className="text-[9px] text-[var(--text-faint)]">{intl.formatMessage({ id: "settings.compaction.revision" }, { revision: settings.revision })}</p>
						<div className="flex items-center gap-3">
							{saveError ? <span role="alert" className="max-w-[300px] text-right text-[9px] leading-4 text-[var(--danger)]">{saveError}</span> : null}
							{saved ? <span className="inline-flex items-center gap-1 text-[9px] font-medium text-[var(--success)]"><Check size={11} />{intl.formatMessage({ id: "settings.compaction.saved" })}</span> : null}
							<button
								type="button"
								className="ui-toolbar-button ui-toolbar-button-primary min-w-20 disabled:cursor-not-allowed disabled:opacity-40"
								disabled={!dirty || saving}
								onClick={() => void save()}
							>
								{intl.formatMessage({ id: saving ? "common.saving" : "common.save" })}
							</button>
						</div>
					</footer>
				</div>
			) : null}
		</SettingsSectionPanel>
	);
}

function LoadingState() {
	const intl = useIntl();
	return <div className="grid min-h-64 place-items-center text-[10px] text-[var(--text-muted)]">{intl.formatMessage({ id: "settings.compaction.loading" })}</div>;
}
