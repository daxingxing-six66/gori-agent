"use client";

import { BrainCircuit, Check, ChevronDown, ImageIcon, Search, Settings2, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { llmProviderApi } from "@/features/llm-provider/api/llm-provider-api";
import { useLlmProviders } from "@/features/llm-provider/components/llm-provider-context";
import { deriveLlmProviderState, type LlmModel } from "@/features/llm-provider/model/llm-provider";
import { useSettings } from "@/features/settings/components/settings-context";

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
	return String(value);
}

export function ModelSelector({ selectedModel, onSelect, disabled = false, modelLabel, attention = false, appearance = "default", showChevron = true, noneOptionLabel, selectedNone = selectedModel === null, popoverLayer = "anchor" }: {
	selectedModel: LlmModel | null;
	onSelect(model: LlmModel | null): void;
	disabled?: boolean;
	modelLabel?: string;
	attention?: boolean;
	appearance?: "default" | "composer";
	showChevron?: boolean;
	noneOptionLabel?: string;
	selectedNone?: boolean;
	popoverLayer?: "anchor" | "settings-dialog";
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const { providers, loading, error, refreshProviders } = useLlmProviders();
	const { openSettings } = useSettings();
	const [open, setOpen] = useState(false);
	const [activeProviderId, setActiveProviderId] = useState("");
	const [query, setQuery] = useState("");
	const [modelsByProvider, setModelsByProvider] = useState<Record<string, readonly LlmModel[]>>({});
	const [loadingProviderIds, setLoadingProviderIds] = useState<string[]>([]);
	const [modelErrors, setModelErrors] = useState<Record<string, unknown>>({});
	const [dialogPopoverPosition, setDialogPopoverPosition] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
	const modelProviders = deriveLlmProviderState(providers ?? []).modelProviders;
	const filteredModels = useMemo(() => {
		const activeModels = modelsByProvider[activeProviderId] ?? [];
		const normalized = query.trim().toLocaleLowerCase();
		return normalized.length === 0
			? activeModels
			: activeModels.filter((model) =>
					`${model.name} ${model.id}`.toLocaleLowerCase().includes(normalized),
				);
	}, [activeProviderId, modelsByProvider, query]);
	const composerAppearance = appearance === "composer";

	useEffect(() => {
		if (!open) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
	}, [open]);

	useLayoutEffect(() => {
		if (!open || popoverLayer !== "settings-dialog") return;
		const dialog = rootRef.current?.closest<HTMLElement>(".settings-dialog");
		const trigger = triggerRef.current;
		if (!dialog || !trigger) return;
		const updatePosition = () => {
			const margin = 20;
			const gap = 10;
			const dialogRect = dialog.getBoundingClientRect();
			const triggerRect = trigger.getBoundingClientRect();
			const width = Math.min(500, dialogRect.width - margin * 2);
			const height = Math.min(360, dialogRect.height - margin * 2);
			const maxLeft = dialogRect.width - width - margin;
			const preferredLeft = triggerRect.right - dialogRect.left - width;
			const left = Math.min(Math.max(preferredLeft, margin), maxLeft);
			const maxTop = dialogRect.height - height - margin;
			const above = triggerRect.top - dialogRect.top - gap - height;
			const below = triggerRect.bottom - dialogRect.top + gap;
			const top = above >= margin ? above : below <= maxTop ? below : Math.min(Math.max(above, margin), maxTop);
			setDialogPopoverPosition({ top, left, width, height });
		};
		updatePosition();
		window.addEventListener("resize", updatePosition);
		document.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			document.removeEventListener("scroll", updatePosition, true);
		};
	}, [open, popoverLayer]);

	useEffect(() => {
		if (!providers || !selectedModel) return;
		if (!providers.some((provider) => provider.id === selectedModel.providerId && provider.configured)) onSelect(null);
	}, [onSelect, providers, selectedModel]);

	const loadModels = async (providerId: string, force = false) => {
		if (!force && modelsByProvider[providerId]) return;
		if (loadingProviderIds.includes(providerId)) return;
		setLoadingProviderIds((current) => [...current, providerId]);
		setModelErrors((current) => {
			const next = { ...current };
			delete next[providerId];
			return next;
		});
		try {
			const response = await llmProviderApi.listModels(providerId);
			setModelsByProvider((current) => ({ ...current, [providerId]: response.models }));
		} catch (requestError) {
			setModelErrors((current) => ({ ...current, [providerId]: requestError }));
		} finally {
			setLoadingProviderIds((current) => current.filter((id) => id !== providerId));
		}
	};

	const openSelector = async () => {
		setOpen(true);
		let availableProviders = providers;
		if (availableProviders === null) {
			try {
				availableProviders = await refreshProviders();
			} catch {
				return;
			}
		}
		const availableModelProviders = deriveLlmProviderState(availableProviders).modelProviders;
		const preferredProviderId = selectedModel?.providerId ?? activeProviderId;
		const nextProviderId = availableModelProviders.some((provider) => provider.id === preferredProviderId)
			? preferredProviderId
			: availableModelProviders[0]?.id ?? "";
		setActiveProviderId(nextProviderId);
		if (nextProviderId) void loadModels(nextProviderId);
	};
	const popoverTarget = rootRef.current === null
		? null
		: popoverLayer === "settings-dialog"
			? rootRef.current.closest<HTMLElement>(".settings-dialog")
			: rootRef.current;
	const canRenderPopover = popoverLayer === "anchor" || dialogPopoverPosition !== null;

	return (
		<div ref={rootRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				className={`model-selector-trigger flex h-7 max-w-[176px] items-center gap-1 rounded-md transition disabled:cursor-default ${composerAppearance ? "px-2 text-[10px] font-medium" : "px-1.5"} ${attention ? "font-medium text-amber-700 hover:text-amber-800" : "text-zinc-500 hover:text-zinc-700 disabled:hover:text-zinc-500"}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => { if (open) setOpen(false); else void openSelector(); }}
			>
				<span className="truncate">{selectedModel?.name ?? modelLabel ?? intl.formatMessage({ id: "provider.selector.select" })}</span>{disabled || !showChevron ? null : <ChevronDown size={10} strokeWidth={1.8} className={`shrink-0 transition ${open ? "rotate-180" : ""}`} />}
			</button>

			{open && popoverTarget && canRenderPopover ? createPortal(
				<div
					ref={popoverRef}
					className={`model-selector-popover flex overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_20px_64px_rgb(15_23_42/18%)] ${popoverLayer === "settings-dialog" ? "absolute z-[100]" : "absolute bottom-[calc(100%+10px)] right-0 z-50 h-[360px] w-[500px] max-w-[calc(100vw-40px)]"}`}
					style={popoverLayer === "settings-dialog" ? dialogPopoverPosition ?? undefined : undefined}
					role="dialog"
					aria-label={intl.formatMessage({ id: "provider.selector.select" })}
				>
					{modelProviders.length > 0 ? (
						<aside className="app-scrollbar w-[148px] shrink-0 overflow-y-auto border-r border-[var(--line-soft)] bg-[#f6f5f1] p-2.5">
							{modelProviders.map((provider) => (
								<button
									type="button"
									key={provider.id}
									className={`mb-1 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition ${activeProviderId === provider.id ? "bg-white text-[#326e52] shadow-[0_1px_2px_rgb(24_24_27/5%)]" : "text-zinc-500 hover:bg-white/60 hover:text-zinc-800"}`}
									onClick={() => { setActiveProviderId(provider.id); setQuery(""); void loadModels(provider.id); }}
								>
									<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${provider.configured ? "bg-[var(--accent)]" : "bg-zinc-300"}`} />
									<span className="min-w-0 truncate text-[9px] font-semibold">{provider.name}</span>
								</button>
							))}
						</aside>
					) : null}

					<div className="flex min-w-0 flex-1 flex-col">
						{loading && providers === null ? <div className="grid flex-1 place-items-center text-[10px] text-zinc-400">{intl.formatMessage({ id: "provider.selector.loading" })}</div> : null}
						{error && providers === null ? <div className="grid flex-1 place-items-center px-6 text-center"><div><p className="text-[10px] leading-5 text-rose-600">{localizedErrorMessage(error)}</p><button type="button" className="mt-3 text-[9px] font-semibold text-[#397b5c]" onClick={() => void refreshProviders().catch(() => undefined)}>{intl.formatMessage({ id: "common.reload" })}</button></div></div> : null}
						{providers !== null && modelProviders.length === 0 && noneOptionLabel === undefined ? <div className="grid flex-1 place-items-center px-8 text-center"><div><span className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-[#edf4f0] text-[#397b5c]"><BrainCircuit size={17} /></span><p className="mt-4 text-[11px] font-semibold text-zinc-700">{intl.formatMessage({ id: "provider.selector.empty" })}</p><p className="mt-1.5 text-[9px] leading-4 text-zinc-400">{intl.formatMessage({ id: "provider.selector.empty.description" })}</p><button type="button" className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#397b5c] px-3 text-[9px] font-semibold text-white" onClick={() => { setOpen(false); openSettings(); }}><Settings2 size={12} /> {intl.formatMessage({ id: "provider.selector.openSettings" })}</button></div></div> : null}

						{modelProviders.length > 0 ? <div className="border-b border-[var(--line-soft)] p-3"><label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--line)] bg-[#fafaf8] px-2.5 text-zinc-400 focus-within:border-[#7aa48e]"><Search size={12} /><input className="min-w-0 flex-1 bg-transparent text-[9px] text-zinc-700 outline-none placeholder:text-zinc-400" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={intl.formatMessage({ id: "provider.selector.search" })} /></label></div> : null}
						{modelProviders.length > 0 || noneOptionLabel ? (
							<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-2.5">
								{noneOptionLabel ? <NoneModelOption label={noneOptionLabel} selected={selectedNone} onSelect={() => { onSelect(null); setOpen(false); }} /> : null}
								{loadingProviderIds.includes(activeProviderId) ? <p className="py-10 text-center text-[9px] text-zinc-400">{intl.formatMessage({ id: "provider.selector.catalogLoading" })}</p> : null}
								{modelErrors[activeProviderId] ? <div className="py-8 text-center"><p className="text-[9px] text-rose-600">{localizedErrorMessage(modelErrors[activeProviderId])}</p><button type="button" className="mt-2 text-[9px] font-semibold text-[#397b5c]" onClick={() => void loadModels(activeProviderId, true)}>{intl.formatMessage({ id: "provider.selector.retry" })}</button></div> : null}
								{modelProviders.length > 0 && !loadingProviderIds.includes(activeProviderId) && !modelErrors[activeProviderId] && filteredModels.length === 0 ? <p className="py-10 text-center text-[9px] text-zinc-400">{intl.formatMessage({ id: "provider.selector.noMatch" })}</p> : null}
								{filteredModels.map((model) => <button type="button" key={model.id} className={`mb-1 flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition hover:bg-[#f4f7f5] ${selectedModel?.id === model.id && selectedModel.providerId === model.providerId ? "bg-[#edf4f0]" : ""}`} onClick={() => { onSelect(model); setOpen(false); }}><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-500"><BrainCircuit size={13} /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><strong className="truncate text-[9px] font-semibold text-zinc-700">{model.name}</strong>{model.reasoning ? <Sparkles size={10} className="shrink-0 text-[#397b5c]" /> : null}</span><span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[8px] text-zinc-400"><span>{model.id}</span><span>{intl.formatMessage({ id: "provider.selector.context" }, { value: formatTokens(model.contextWindow) })}</span>{model.input.includes("image") ? <span className="inline-flex items-center gap-1"><ImageIcon size={9} /> {intl.formatMessage({ id: "provider.selector.image" })}</span> : null}</span></span><Check size={13} className={`mt-1 shrink-0 text-[#397b5c] ${selectedModel?.id === model.id && selectedModel.providerId === model.providerId ? "opacity-100" : "opacity-0"}`} /></button>)}
							</div>
						) : null}
					</div>
				</div>,
				popoverTarget,
			) : null}
		</div>
	);
}

function NoneModelOption({ label, selected, onSelect }: { label: string; selected: boolean; onSelect(): void }) {
	return (
		<button type="button" className={`mb-1 flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition hover:bg-[#f4f7f5] ${selected ? "bg-[#edf4f0]" : ""}`} onClick={onSelect}>
			<span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-500"><BrainCircuit size={13} /></span>
			<strong className="min-w-0 flex-1 truncate text-[9px] font-semibold text-zinc-700">{label}</strong>
			<Check size={13} className={`shrink-0 text-[#397b5c] ${selected ? "opacity-100" : "opacity-0"}`} />
		</button>
	);
}
