"use client";

import { Check, CircleAlert, CircleCheck, CirclePlus, Clock3, Download, LoaderCircle, ShieldCheck, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useIntl, type IntlShape } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import { GuardRuleDialog } from "@/features/guard/components/guard-rule-dialog";
import { GuardRulePackDialog } from "@/features/guard/components/guard-rule-pack-dialog";
import { GuardRuleSwitch } from "@/features/guard/components/guard-rule-switch";
import { type GuardSaveStatus, useGuardAutosave } from "@/features/guard/components/use-guard-autosave";
import type { GuardMatch, GuardRuleDraft, UpdateGuardRuleInput } from "@/features/guard/model/guard";
import { validateGuardRule } from "@/features/guard/model/guard-editor-state";

const inputClass = "h-10 w-full rounded-lg border border-[var(--line)] bg-white px-3 text-[11px] text-zinc-800 outline-none transition focus:border-[#7aa48e] focus:ring-2 focus:ring-[#397b5c]/10";
function SaveIndicator({ invalid, status }: { invalid: boolean; status: GuardSaveStatus }) {
	const intl = useIntl();
	if (status === "saving") return <span className="flex items-center gap-1.5 text-[10px] text-zinc-500"><LoaderCircle className="animate-spin" size={13} /> {intl.formatMessage({ id: "guard.save.saving" })}</span>;
	if (status === "pending") return <span className="flex items-center gap-1.5 text-[10px] text-amber-700"><Clock3 size={13} /> {intl.formatMessage({ id: invalid ? "guard.save.incomplete" : "guard.save.pending" })}</span>;
	if (status === "error") return <span className="flex items-center gap-1.5 text-[10px] text-rose-600"><CircleAlert size={13} /> {intl.formatMessage({ id: "guard.save.failed" })}</span>;
	if (status === "conflict") return <span className="flex items-center gap-1.5 text-[10px] text-amber-700"><CircleAlert size={13} /> {intl.formatMessage({ id: "guard.save.conflict" })}</span>;
	return <span className="flex items-center gap-1.5 text-[10px] text-zinc-400"><CircleCheck size={13} /> {intl.formatMessage({ id: "guard.save.saved" })}</span>;
}

export function GuardEditor({ workspaceId }: { workspaceId: string }) {
	const intl = useIntl();
	const autosave = useGuardAutosave(workspaceId);
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const [rulePackDialogOpen, setRulePackDialogOpen] = useState(false);
	const [deleteConfirmKey, setDeleteConfirmKey] = useState<string | null>(null);

	const createRule = async (input: UpdateGuardRuleInput) => {
		await autosave.createRule(input);
		setAddDialogOpen(false);
	};

	const confirmDelete = (clientKey: string) => {
		autosave.deleteRule(clientKey);
		setDeleteConfirmKey(null);
	};

	if (autosave.status === "loading" && autosave.guard === null) {
		return <div className="py-10 text-center text-[10px] text-zinc-400">{intl.formatMessage({ id: "guard.loading" })}</div>;
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div className="flex items-center gap-3">
					<span className="text-[11px] font-semibold text-zinc-700">{intl.formatMessage({ id: "guard.rules.count" }, { count: autosave.rules.length })}</span>
					<span className="h-3 w-px bg-zinc-200" />
					<SaveIndicator invalid={autosave.invalid} status={autosave.status} />
				</div>
				<div className="flex items-center gap-2">
					<button type="button" className="flex h-9 items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-4 text-[10px] font-semibold text-zinc-600 transition hover:border-[#a9c3b5] hover:bg-[#f8fbf9] hover:text-[#397b5c] disabled:cursor-not-allowed disabled:opacity-45" disabled={!autosave.guard || autosave.conflict !== null || autosave.importingRulePacks} onClick={() => setRulePackDialogOpen(true)}><Download size={13} /> {intl.formatMessage({ id: "guard.import.open" })}</button>
					<button type="button" className="flex h-9 items-center gap-2 rounded-lg bg-[#397b5c] px-4 text-[10px] font-semibold text-white shadow-sm transition hover:bg-[#326e52] disabled:cursor-not-allowed disabled:opacity-45" disabled={!autosave.guard || autosave.conflict !== null || autosave.importingRulePacks} onClick={() => setAddDialogOpen(true)}><CirclePlus size={14} /> {intl.formatMessage({ id: "guard.rule.add" })}</button>
				</div>
			</div>

			{autosave.conflict ? (
				<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3" role="alert">
					<div className="flex items-center gap-2 text-[10px] text-amber-800"><CircleAlert size={14} /> {intl.formatMessage({ id: "guard.conflict.title" })}</div>
					<div className="flex items-center gap-2"><button type="button" className="h-8 rounded-lg border border-amber-300 bg-white px-3 text-[9px] font-semibold text-amber-800" onClick={autosave.useServerVersion}>{intl.formatMessage({ id: "guard.conflict.server" })}</button><button type="button" className="h-8 rounded-lg bg-amber-800 px-3 text-[9px] font-semibold text-white" onClick={autosave.reapplyLocalChanges}>{intl.formatMessage({ id: "guard.conflict.reapply" })}</button></div>
				</div>
			) : autosave.error ? <button type="button" className="flex w-full items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-left text-[10px] text-rose-700" onClick={autosave.flushNow}><span>{autosave.error}</span><span className="font-semibold">{intl.formatMessage({ id: "common.reload" })}</span></button> : null}

			<fieldset className="space-y-3 disabled:cursor-wait disabled:opacity-70" disabled={autosave.importingRulePacks}>
				{autosave.rules.length === 0 ? (
					<div className="grid min-h-44 place-items-center border-y border-dashed border-zinc-200 text-center">
						<div><ShieldCheck className="mx-auto text-zinc-300" size={24} /><p className="mt-3 text-[10px] text-zinc-400">{intl.formatMessage({ id: "guard.empty" })}</p></div>
					</div>
				) : null}
				{autosave.rules.map((rule) => (
					<GuardRuleCard
						key={rule.clientKey}
						rule={rule}
						conflicted={autosave.status === "conflict"}
						deleting={deleteConfirmKey === rule.clientKey}
						highlighted={autosave.highlightedRuleKeys.includes(rule.clientKey)}
						switchPending={autosave.pendingSwitchKeys.includes(rule.clientKey)}
						onBlur={() => autosave.scheduleSave(0)}
						onChange={(update, immediate) => autosave.updateRule(rule.clientKey, update, immediate)}
						onRequestDelete={() => setDeleteConfirmKey(rule.clientKey)}
						onConfirmDelete={() => confirmDelete(rule.clientKey)}
						onCancelDelete={() => setDeleteConfirmKey(null)}
					/>
				))}
			</fieldset>

			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--line-soft)] pt-4 text-[10px] text-zinc-400">
				<span className="flex items-center gap-1.5 font-medium text-zinc-500"><ShieldCheck size={13} className="text-rose-500" /> {intl.formatMessage({ id: "guard.recentBlock" })}</span>
				<code className="rounded-md bg-zinc-100 px-2 py-1 font-mono text-zinc-600">systemctl stop sshd</code>
				<span>{intl.formatMessage({ id: "guard.staticData" })}</span>
			</div>

			{addDialogOpen ? <GuardRuleDialog onClose={() => setAddDialogOpen(false)} onCreate={createRule} /> : null}
			{rulePackDialogOpen ? <GuardRulePackDialog workspaceId={workspaceId} onClose={() => setRulePackDialogOpen(false)} onImport={autosave.importRulePacks} /> : null}
		</div>
	);
}

function GuardRuleCard({ rule, conflicted, deleting, highlighted, switchPending, onBlur, onChange, onRequestDelete, onConfirmDelete, onCancelDelete }: {
	rule: GuardRuleDraft;
	conflicted: boolean;
	deleting: boolean;
	highlighted: boolean;
	switchPending: boolean;
	onBlur(): void;
	onChange(update: Partial<GuardRuleDraft>, immediate?: boolean): void;
	onRequestDelete(): void;
	onConfirmDelete(): void;
	onCancelDelete(): void;
}) {
	const intl = useIntl();
	const validation = validateGuardRule(rule);
	const matchOptions = guardMatchOptions(intl);
	const fallbackName = rule.displayName || intl.formatMessage({ id: "guard.rule.fallback" });
	return (
		<section className={`guard-rule-card rounded-[14px] border p-4 transition-all ${highlighted ? "guard-rule-card-created border-[#9bcbb4] bg-[#f1f8f4]" : rule.enabled ? "border-[var(--line-soft)] bg-white" : "border-zinc-200 bg-zinc-50/70 opacity-70"}`}>
			<div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
				<label className="block">
					<span className="mb-1.5 flex items-center gap-2 text-[9px] font-medium text-zinc-500">{intl.formatMessage({ id: "guard.rule.name" })}{rule.source === "builtin" ? <span className="rounded-full bg-[#eaf2ec] px-1.5 py-0.5 text-[8px] font-medium text-[#397b5c]">{intl.formatMessage({ id: "guard.rule.preset" })}</span> : null}</span>
					<input className={`${inputClass} text-[12px] font-semibold`} value={rule.displayName} onBlur={onBlur} onChange={(event) => onChange({ displayName: event.target.value })} />
					{validation.displayName ? <span className="mt-1.5 block text-[9px] text-rose-600" role="alert">{intl.formatMessage({ id: "guard.rule.validation.nameRequired" })}</span> : null}
				</label>
				<div className="flex h-10 items-center gap-2 sm:mt-[17px]">
					<GuardRuleSwitch checked={rule.enabled} disabled={conflicted} label={intl.formatMessage({ id: "guard.rule.enabledState" }, { name: fallbackName })} pending={switchPending} onChange={(checked) => onChange({ enabled: checked }, true)} />
					{deleting ? <span className="flex items-center gap-1 rounded-lg bg-rose-50 p-1"><button type="button" className="rounded-md p-1.5 text-rose-600 hover:bg-rose-100" aria-label={intl.formatMessage({ id: "guard.rule.delete.confirm" }, { name: fallbackName })} onClick={onConfirmDelete}><Check size={13} /></button><button type="button" className="rounded-md p-1.5 text-zinc-400 hover:bg-white" aria-label={intl.formatMessage({ id: "guard.rule.delete.cancel" })} onClick={onCancelDelete}><X size={13} /></button></span> : <button type="button" className="rounded-lg p-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-600" aria-label={intl.formatMessage({ id: "guard.rule.delete" }, { name: fallbackName })} onClick={onRequestDelete}><Trash2 size={14} /></button>}
				</div>
			</div>
			<div className="mt-4 grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
				<label className="block"><span className="mb-1.5 block text-[9px] font-medium text-zinc-500">{intl.formatMessage({ id: "guard.rule.match" })}</span><CustomSelect ariaLabel={intl.formatMessage({ id: "guard.rule.match" })} compact value={rule.match} onChange={(value) => onChange({ match: value as GuardMatch }, true)} options={matchOptions} /></label>
				<label className="block">
					<span className="mb-1.5 block text-[9px] font-medium text-zinc-500">{intl.formatMessage({ id: "guard.rule.pattern" })}</span>
					<input className={`${inputClass} font-mono`} value={rule.pattern} onBlur={onBlur} onChange={(event) => onChange({ pattern: event.target.value })} />
					{validation.pattern ? <span className="mt-1.5 block text-[9px] text-rose-600" role="alert">{intl.formatMessage({ id: validation.pattern === "invalid_regex" ? "guard.rule.validation.regexInvalid" : "guard.rule.validation.patternRequired" })}</span> : null}
				</label>
			</div>
			<label className="mt-4 block"><span className="mb-1.5 block text-[9px] font-medium text-zinc-500">{intl.formatMessage({ id: "guard.rule.reason" })} <span className="font-normal text-zinc-400">{intl.formatMessage({ id: "common.optional" })}</span></span><input className={inputClass} value={rule.reason ?? ""} onBlur={onBlur} onChange={(event) => onChange({ reason: event.target.value || undefined })} /></label>
		</section>
	);
}

function guardMatchOptions(intl: IntlShape) {
	return [
		{ value: "contains", label: intl.formatMessage({ id: "guard.rule.match.contains" }) },
		{ value: "starts_with", label: intl.formatMessage({ id: "guard.rule.match.startsWith" }) },
		{ value: "regex", label: intl.formatMessage({ id: "guard.rule.match.regex" }) },
	];
}
