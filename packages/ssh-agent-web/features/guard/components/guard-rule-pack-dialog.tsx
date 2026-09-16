"use client";

import { Check, PackageOpen, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useIntl, type IntlShape } from "react-intl";
import { guardApi } from "@/features/guard/api/guard-api";
import {
	defaultSelectedRulePackIds,
	guardRulePackPlaceholders,
	selectedRuleCount,
} from "@/features/guard/model/guard-rule-pack-state";
import type {
	GuardRulePackSummary,
	ImportGuardRulePacksResponse,
} from "@/features/guard/model/guard";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { ApiError } from "@/shared/errors/api-error";

interface GuardRulePackDialogProps {
	workspaceId: string;
	onClose(): void;
	onImport(packIds: string[]): Promise<ImportGuardRulePacksResponse>;
}

export function GuardRulePackDialog({ workspaceId, onClose, onImport }: GuardRulePackDialogProps) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const dialogRef = useRef<HTMLFormElement>(null);
	const onCloseRef = useRef(onClose);
	const submittingRef = useRef(false);
	const selectionInitializedRef = useRef(false);
	const [packs, setPacks] = useState<GuardRulePackSummary[] | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [loadError, setLoadError] = useState<"pending" | "retry" | null>(null);
	const [submitError, setSubmitError] = useState<unknown>(null);
	const [result, setResult] = useState<ImportGuardRulePacksResponse | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		onCloseRef.current = onClose;
		submittingRef.current = submitting;
	}, [onClose, submitting]);

	useEffect(() => {
		const controller = new AbortController();
		void Promise.resolve().then(async () => {
			if (controller.signal.aborted) return;
			setLoading(true);
			setLoadError(null);
			try {
				const response = await guardApi.listRulePacks(workspaceId, controller.signal);
				setPacks(response.packs);
				setSelectedIds((current) => {
					if (!selectionInitializedRef.current) {
						selectionInitializedRef.current = true;
						return new Set(defaultSelectedRulePackIds(response.packs));
					}
					const availableIds = new Set(response.packs
						.filter((pack) => pack.availableRuleCount > 0)
						.map((pack) => pack.id));
					return new Set([...current].filter((id) => availableIds.has(id)));
				});
			} catch (requestError) {
				if (controller.signal.aborted) return;
				setPacks(null);
				setLoadError(requestError instanceof ApiError && requestError.status === 404 ? "pending" : "retry");
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		});
		return () => controller.abort();
	}, [reloadKey, workspaceId]);

	useEffect(() => {
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.focus();
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !submittingRef.current) {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
			);
			if (!focusable || focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			previousFocus?.focus();
		};
	}, []);

	const availableCount = useMemo(
		() => packs ? selectedRuleCount(packs, selectedIds) : 0,
		[packs, selectedIds],
	);
	const close = () => {
		if (!submitting) onClose();
	};
	const togglePack = (pack: GuardRulePackSummary) => {
		if (submitting || pack.availableRuleCount === 0) return;
		setResult(null);
		setSubmitError(null);
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(pack.id)) next.delete(pack.id);
			else next.add(pack.id);
			return next;
		});
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!packs || availableCount === 0 || submitting) return;
		setSubmitting(true);
		setSubmitError(null);
		setResult(null);
		void onImport([...selectedIds]).then((response) => {
			setResult(response);
			setSelectedIds(new Set());
			setReloadKey((current) => current + 1);
		}).catch((requestError: unknown) => {
			setSubmitError(requestError);
			if (requestError instanceof ApiError && requestError.code === "revision_conflict") {
				setReloadKey((current) => current + 1);
			}
		}).finally(() => setSubmitting(false));
	};
	const importedCount = result?.results.reduce((total, item) => total + item.importedCount, 0) ?? 0;
	const skippedCount = result?.results.reduce((total, item) => total + item.skippedCount, 0) ?? 0;

	return (
		<div className="management-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
			<form ref={dialogRef} className="management-dialog guard-rule-pack-dialog" role="dialog" aria-modal="true" aria-labelledby="guard-rule-pack-dialog-title" tabIndex={-1} onSubmit={submit}>
				<header className="flex items-center justify-between gap-4 border-b border-[var(--line-soft)] px-6 py-5">
					<div className="flex items-center gap-3">
						<span className="grid h-9 w-9 place-items-center rounded-xl bg-[#eaf2ec] text-[#397b5c]"><PackageOpen size={17} /></span>
						<div>
							<h2 id="guard-rule-pack-dialog-title" className="text-[15px] font-semibold tracking-[-0.02em] text-zinc-900">{intl.formatMessage({ id: "guard.pack.title" })}</h2>
							<p className="mt-1 text-[9px] text-zinc-400">{intl.formatMessage({ id: "guard.pack.description" })}</p>
						</div>
					</div>
					<button type="button" className="rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40" disabled={submitting} onClick={close} aria-label={intl.formatMessage({ id: "common.close" })}><X size={17} /></button>
				</header>

				<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
					{loadError ? (
						<div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] text-amber-800" role="alert">
							<span>{intl.formatMessage({ id: loadError === "pending" ? "guard.pack.unavailablePending" : "guard.pack.unavailableRetry" })}</span>
							<button type="button" className="flex shrink-0 items-center gap-1 font-semibold" onClick={() => setReloadKey((current) => current + 1)}><RefreshCw size={12} /> {intl.formatMessage({ id: "common.reload" })}</button>
						</div>
					) : null}
					{submitError ? <p className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-[10px] text-rose-700" role="alert">{localizedErrorMessage(submitError)}</p> : null}
					{result ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[10px] text-emerald-800" role="status">{intl.formatMessage({ id: "guard.pack.result" }, { imported: importedCount, skipped: skippedCount })}</p> : null}

					<div className="grid gap-3 sm:grid-cols-2">
						{packs ? packs.map((pack) => {
							const selected = selectedIds.has(pack.id);
							const fullyImported = pack.availableRuleCount === 0;
							return (
								<button
									type="button"
									key={pack.id}
									role="checkbox"
									aria-checked={selected}
									disabled={submitting || fullyImported}
									className={`group min-h-[104px] rounded-xl border p-4 text-left transition ${selected ? "border-[#8fbaa4] bg-[#f1f7f3] shadow-[0_0_0_2px_rgb(57_123_92/8%)]" : "border-[var(--line-soft)] bg-white hover:border-[#b9cfc3] hover:bg-[#fafcfb]"} disabled:cursor-default disabled:opacity-60`}
									onClick={() => togglePack(pack)}
								>
									<span className="flex items-start justify-between gap-3">
										<span className="min-w-0">
											<span className="flex items-center gap-2 text-[11px] font-semibold text-zinc-800">{rulePackText(intl, pack.id, "name", pack.name)}{pack.recommended ? <span className="rounded-full bg-[#e8f1eb] px-1.5 py-0.5 text-[8px] font-medium text-[#397b5c]">{intl.formatMessage({ id: "guard.pack.recommended" })}</span> : null}</span>
											<span className="mt-2 block text-[9px] leading-4 text-zinc-500">{rulePackText(intl, pack.id, "description", pack.description)}</span>
										</span>
										<span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border transition ${selected ? "border-[#397b5c] bg-[#397b5c] text-white" : "border-zinc-300 text-transparent"}`}><Check size={12} /></span>
									</span>
									<span className="mt-3 flex items-center justify-between text-[9px] text-zinc-400">
										<span>{intl.formatMessage({ id: "guard.pack.rules" }, { count: pack.ruleCount, version: pack.version })}</span>
										<span className={fullyImported ? "font-medium text-[#397b5c]" : pack.importedRuleCount > 0 ? "font-medium text-amber-700" : ""}>{intl.formatMessage({ id: fullyImported ? "guard.pack.imported" : pack.importedRuleCount > 0 ? "guard.pack.supplement" : "guard.pack.notImported" }, { count: pack.availableRuleCount })}</span>
									</span>
								</button>
							);
						}) : guardRulePackPlaceholders.map((pack) => (
							<div key={pack.id} className="min-h-[104px] rounded-xl border border-[var(--line-soft)] bg-zinc-50/60 p-4 opacity-65">
								<span className="flex items-center gap-2 text-[11px] font-semibold text-zinc-700">{rulePackText(intl, pack.id, "name")}{pack.recommended ? <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[8px] font-medium text-zinc-500">{intl.formatMessage({ id: "guard.pack.recommended" })}</span> : null}</span>
								<p className="mt-2 text-[9px] leading-4 text-zinc-500">{rulePackText(intl, pack.id, "description")}</p>
								<p className="mt-3 text-[9px] text-zinc-400">{intl.formatMessage({ id: loading ? "guard.pack.catalog.loading" : "guard.pack.catalog.waiting" })}</p>
							</div>
						))}
					</div>
				</div>

				<footer className="flex items-center justify-between gap-4 border-t border-[var(--line-soft)] px-6 py-4">
					<span className="flex items-center gap-1.5 text-[9px] text-zinc-400"><ShieldCheck size={12} /> {intl.formatMessage({ id: packs ? "guard.pack.estimate" : "guard.pack.catalog.unavailable" }, { count: availableCount })}</span>
					<div className="flex items-center gap-2">
						<button type="button" className="h-9 rounded-lg border border-[var(--line)] px-4 text-[10px] font-semibold text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40" disabled={submitting} onClick={close}>{intl.formatMessage({ id: "common.cancel" })}</button>
						<button type="submit" className="h-9 rounded-lg bg-[#397b5c] px-4 text-[10px] font-semibold text-white shadow-sm transition hover:bg-[#326e52] disabled:cursor-not-allowed disabled:opacity-45" disabled={!packs || availableCount === 0 || submitting}>{intl.formatMessage({ id: submitting ? "guard.pack.importing" : "guard.pack.import" })}</button>
					</div>
				</footer>
			</form>
		</div>
	);
}

function rulePackText(intl: IntlShape, packId: string, field: "description" | "name", fallback?: string): string {
	const prefix = ({
		"linux-critical": "guard.pack.linux",
		"ssh-protection": "guard.pack.ssh",
		"disk-protection": "guard.pack.disk",
		"network-protection": "guard.pack.network",
	} as const)[packId as "linux-critical" | "ssh-protection" | "disk-protection" | "network-protection"];
	return prefix ? intl.formatMessage({ id: `${prefix}.${field}` }) : fallback ?? packId;
}
