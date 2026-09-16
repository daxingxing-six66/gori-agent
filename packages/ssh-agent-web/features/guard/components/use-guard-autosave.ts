"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { guardApi } from "@/features/guard/api/guard-api";
import type {
	Guard,
	GuardRuleDraft,
	ImportGuardRulePacksResponse,
	UpdateGuardRuleInput,
} from "@/features/guard/model/guard";
import {
	buildGuardRulePayload,
	hasGuardRuleErrors,
	rebaseGuardRules,
	reconcileGuardRules,
	toGuardRuleDrafts,
	validateGuardRule,
} from "@/features/guard/model/guard-editor-state";
import { ApiError } from "@/shared/errors/api-error";

export type GuardSaveStatus = "conflict" | "error" | "loading" | "pending" | "saved" | "saving";

export interface GuardConflict {
	base: Guard;
	latest: Guard;
	localRules: GuardRuleDraft[];
}

interface DeletedRule {
	index: number;
	rule: GuardRuleDraft;
}

function hasInvalidRules(rules: GuardRuleDraft[]): boolean {
	return rules.some((rule) => hasGuardRuleErrors(validateGuardRule(rule)));
}

export function useGuardAutosave(workspaceId: string) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [guard, setGuardState] = useState<Guard | null>(null);
	const [rules, setRulesState] = useState<GuardRuleDraft[]>([]);
	const [status, setStatus] = useState<GuardSaveStatus>("loading");
	const [saveError, setSaveError] = useState<{ type: "conflict" } | { type: "request"; cause: unknown } | null>(null);
	const [conflict, setConflict] = useState<GuardConflict | null>(null);
	const [highlightedRuleKeys, setHighlightedRuleKeys] = useState<string[]>([]);
	const [pendingSwitchKeys, setPendingSwitchKeys] = useState<string[]>([]);
	const [importingRulePacks, setImportingRulePacks] = useState(false);
	const guardRef = useRef<Guard | null>(null);
	const rulesRef = useRef<GuardRuleDraft[]>([]);
	const conflictRef = useRef<GuardConflict | null>(null);
	const deletedRulesRef = useRef<DeletedRule[]>([]);
	const enabledRollbackRef = useRef(new Map<string, boolean>());
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const queueRef = useRef<Promise<void>>(Promise.resolve());
	const importingRulePacksRef = useRef(false);
	const flushRef = useRef<() => void>(() => undefined);

	const replaceGuard = useCallback((next: Guard) => {
		guardRef.current = next;
		setGuardState(next);
	}, []);

	const replaceRules = useCallback((next: GuardRuleDraft[]) => {
		rulesRef.current = next;
		setRulesState(next);
	}, []);

	const replaceConflict = useCallback((next: GuardConflict | null) => {
		conflictRef.current = next;
		setConflict(next);
	}, []);

	const highlightRules = useCallback((clientKeys: string[]) => {
		setHighlightedRuleKeys(clientKeys);
		if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
		highlightTimerRef.current = setTimeout(() => setHighlightedRuleKeys([]), 1400);
	}, []);

	const completeEnabledSwitches = useCallback((clientKeys: ReadonlySet<string>) => {
		if (clientKeys.size === 0) return;
		for (const clientKey of clientKeys) enabledRollbackRef.current.delete(clientKey);
		setPendingSwitchKeys((current) => current.filter((clientKey) => !clientKeys.has(clientKey)));
	}, []);

	const rollbackEnabledSwitches = useCallback((clientKeys: ReadonlySet<string>) => {
		if (clientKeys.size === 0) return;
		const next = rulesRef.current.map((rule) => {
			const previous = enabledRollbackRef.current.get(rule.clientKey);
			return clientKeys.has(rule.clientKey) && previous !== undefined ? { ...rule, enabled: previous } : rule;
		});
		replaceRules(next);
		completeEnabledSwitches(clientKeys);
	}, [completeEnabledSwitches, replaceRules]);

	const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
		const queued = queueRef.current.then(operation, operation);
		queueRef.current = queued.catch(() => undefined);
		return queued;
	}, []);

	const restoreDeletedRules = useCallback(() => {
		if (deletedRulesRef.current.length === 0) return;
		const restored = [...rulesRef.current];
		for (const deleted of [...deletedRulesRef.current].sort((left, right) => left.index - right.index)) {
			if (!restored.some((rule) => rule.clientKey === deleted.rule.clientKey)) {
				restored.splice(deleted.index, 0, deleted.rule);
			}
		}
		deletedRulesRef.current = [];
		replaceRules(restored);
	}, [replaceRules]);

	const handleSaveError = useCallback(async (requestError: unknown, base: Guard, submittedSwitchKeys: ReadonlySet<string>) => {
		rollbackEnabledSwitches(submittedSwitchKeys);
		if (requestError instanceof ApiError && requestError.code === "revision_conflict") {
			try {
				const latest = await guardApi.get(workspaceId);
				replaceConflict({ base, latest, localRules: rulesRef.current });
				setStatus("conflict");
				setSaveError({ type: "conflict" });
				return;
			} catch (loadError) {
				setSaveError({ type: "request", cause: loadError });
			}
		} else {
			restoreDeletedRules();
			setSaveError({ type: "request", cause: requestError });
		}
		setStatus("error");
	}, [replaceConflict, restoreDeletedRules, rollbackEnabledSwitches, workspaceId]);

	const runSave = useCallback(async (extraRule?: GuardRuleDraft) => {
		if (conflictRef.current) throw new Error("Guard conflict must be resolved before saving");
		const base = guardRef.current;
		if (!base) return;
		const currentRules = rulesRef.current;
		const drafts = extraRule ? [...currentRules, extraRule] : currentRules;
		const payload = buildGuardRulePayload(drafts, base.rules);
		const enabled = payload.rules.length > 0;
		const submittedSwitchKeys = new Set(enabledRollbackRef.current.keys());
		if (!payload.hasChanges && enabled === base.enabled) {
			rollbackEnabledSwitches(submittedSwitchKeys);
			setSaveError(null);
			setStatus(hasInvalidRules(currentRules) ? "pending" : "saved");
			return;
		}

		setStatus("saving");
		setSaveError(null);
		try {
			const updated = await guardApi.update(workspaceId, enabled, payload.rules, base.revision);
			const appendKeys = extraRule ? new Set([extraRule.clientKey]) : new Set<string>();
			const reconciled = reconcileGuardRules(rulesRef.current, payload.submittedDrafts, updated.rules, appendKeys);
			replaceGuard(updated);
			replaceRules(reconciled);
			completeEnabledSwitches(submittedSwitchKeys);
			const serverRuleIds = new Set(updated.rules.map((rule) => rule.id));
			deletedRulesRef.current = deletedRulesRef.current.filter(
				({ rule }) => rule.id !== undefined && serverRuleIds.has(rule.id),
			);
			if (extraRule) {
				highlightRules([extraRule.clientKey]);
			}
			const remaining = buildGuardRulePayload(reconciled, updated.rules);
			const hasRemainingChanges = remaining.hasChanges || (remaining.rules.length > 0) !== updated.enabled;
			setStatus(hasRemainingChanges || hasInvalidRules(reconciled) ? "pending" : "saved");
			if (hasRemainingChanges) setTimeout(() => flushRef.current(), 0);
		} catch (requestError) {
			await handleSaveError(requestError, base, submittedSwitchKeys);
			throw requestError;
		}
	}, [completeEnabledSwitches, handleSaveError, highlightRules, replaceGuard, replaceRules, rollbackEnabledSwitches, workspaceId]);

	const flushNow = useCallback(() => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		void enqueue(() => runSave()).catch(() => undefined);
	}, [enqueue, runSave]);

	useEffect(() => {
		flushRef.current = flushNow;
	}, [flushNow]);

	const scheduleSave = useCallback((delay: number) => {
		if (conflictRef.current) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => flushRef.current(), delay);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		guardApi.get(workspaceId, controller.signal).then((current) => {
			const nextRules = toGuardRuleDrafts(current.rules);
			replaceGuard(current);
			replaceRules(nextRules);
			replaceConflict(null);
			setSaveError(null);
			setStatus("saved");
			if (current.enabled !== (current.rules.length > 0)) setTimeout(() => flushRef.current(), 0);
		}).catch((requestError: unknown) => {
			if (!controller.signal.aborted) {
				setSaveError({ type: "request", cause: requestError });
				setStatus("error");
			}
		});
		return () => {
			controller.abort();
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
		};
	}, [replaceConflict, replaceGuard, replaceRules, workspaceId]);

	const updateRule = useCallback((clientKey: string, update: Partial<GuardRuleDraft>, immediate = false) => {
		const current = rulesRef.current.find((rule) => rule.clientKey === clientKey);
		if (!current) return;
		if (immediate && update.enabled !== undefined && update.enabled !== current.enabled) {
			if (!enabledRollbackRef.current.has(clientKey)) enabledRollbackRef.current.set(clientKey, current.enabled);
			setPendingSwitchKeys((keys) => keys.includes(clientKey) ? keys : [...keys, clientKey]);
		}
		const next = rulesRef.current.map((rule) => rule.clientKey === clientKey ? { ...rule, ...update } : rule);
		replaceRules(next);
		setStatus("pending");
		setSaveError(null);
		scheduleSave(immediate ? 0 : 600);
	}, [replaceRules, scheduleSave]);

	const deleteRule = useCallback((clientKey: string) => {
		const index = rulesRef.current.findIndex((rule) => rule.clientKey === clientKey);
		const rule = rulesRef.current[index];
		if (!rule || index < 0) return;
		deletedRulesRef.current.push({ index, rule });
		replaceRules(rulesRef.current.filter((candidate) => candidate.clientKey !== clientKey));
		setStatus("pending");
		setSaveError(null);
		scheduleSave(0);
	}, [replaceRules, scheduleSave]);

	const createRule = useCallback(async (input: UpdateGuardRuleInput) => {
		const draft: GuardRuleDraft = { ...input, clientKey: crypto.randomUUID() };
		await enqueue(() => runSave(draft));
	}, [enqueue, runSave]);

	const importRulePacks = useCallback(async (packIds: string[]): Promise<ImportGuardRulePacksResponse> => {
		if (importingRulePacksRef.current) throw new Error("Guard rule pack import is already running");
		importingRulePacksRef.current = true;
		setImportingRulePacks(true);
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		try {
			let response: ImportGuardRulePacksResponse | undefined;
			await enqueue(async () => {
				await runSave();
				const base = guardRef.current;
				if (!base || conflictRef.current) throw new Error("Guard is not ready for rule pack import");
				const previousRuleIds = new Set(base.rules.map((rule) => rule.id));
				try {
					response = await guardApi.importRulePacks(workspaceId, packIds, base.revision);
				} catch (requestError) {
					if (requestError instanceof ApiError && requestError.code === "revision_conflict") {
						const latest = await guardApi.get(workspaceId);
						replaceGuard(latest);
						replaceRules(toGuardRuleDrafts(latest.rules));
						replaceConflict(null);
						setStatus("saved");
						setSaveError(null);
					}
					throw requestError;
				}
				const imported = response.guard.rules
					.filter((rule) => !previousRuleIds.has(rule.id))
					.map((rule) => rule.id);
				replaceGuard(response.guard);
				replaceRules(toGuardRuleDrafts(response.guard.rules));
				replaceConflict(null);
				deletedRulesRef.current = [];
				enabledRollbackRef.current.clear();
				setPendingSwitchKeys([]);
				setSaveError(null);
				setStatus("saved");
				if (imported.length > 0) highlightRules(imported);
			});
			if (!response) throw new Error("Guard rule pack import returned no response");
			return response;
		} finally {
			importingRulePacksRef.current = false;
			setImportingRulePacks(false);
		}
	}, [enqueue, highlightRules, replaceConflict, replaceGuard, replaceRules, runSave, workspaceId]);

	const useServerVersion = useCallback(() => {
		const currentConflict = conflictRef.current;
		if (!currentConflict) return;
		replaceGuard(currentConflict.latest);
		replaceRules(toGuardRuleDrafts(currentConflict.latest.rules));
		replaceConflict(null);
		deletedRulesRef.current = [];
		setSaveError(null);
		setStatus("saved");
	}, [replaceConflict, replaceGuard, replaceRules]);

	const reapplyLocalChanges = useCallback(() => {
		const currentConflict = conflictRef.current;
		if (!currentConflict) return;
		const rebased = rebaseGuardRules(
			currentConflict.base.rules,
			currentConflict.localRules,
			currentConflict.latest.rules,
		);
		replaceGuard(currentConflict.latest);
		replaceRules(rebased);
		replaceConflict(null);
		setSaveError(null);
		setStatus("pending");
		scheduleSave(0);
	}, [replaceConflict, replaceGuard, replaceRules, scheduleSave]);

	return {
		guard,
		rules,
		status,
		error: saveError === null
			? null
			: saveError.type === "conflict"
				? intl.formatMessage({ id: "guard.conflict.description" })
				: localizedErrorMessage(saveError.cause),
		conflict,
		highlightedRuleKeys,
		pendingSwitchKeys,
		importingRulePacks,
		invalid: hasInvalidRules(rules),
		flushNow,
		scheduleSave,
		updateRule,
		deleteRule,
		createRule,
		importRulePacks,
		useServerVersion,
		reapplyLocalChanges,
	};
}
