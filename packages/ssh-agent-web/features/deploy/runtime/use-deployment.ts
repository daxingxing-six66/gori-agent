"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/features/i18n/components/locale-context";
import type { ChatMessage } from "@/features/chat/model/chat";
import { ApiError } from "@/shared/errors/api-error";
import { deploymentApi } from "../api/deployment-api";
import type { DeploymentDiscussion, DeploymentRemoteStage, DeploymentRun } from "../model/deployment";
import { newestDeploymentRun } from "../model/deployment-history";
import { useDeploymentCatalog } from "./use-deployment-catalog";
import { useDeploymentTasks } from "./use-deployment-tasks";
import { subscribeDeploymentEvents } from "./deployment-event-stream";
import { DeploymentLogStore } from "./deployment-log-store";

interface Selection { open: boolean; id: string | null; loading: boolean }
const initialSelection = (): Selection => ({ open: false, id: null, loading: false });

/** Assembles facts and presentation. The server alone chooses the active deployment identity. */
export function useDeployment(sessionId: string, workspaceId: string | undefined, options: {
	onHistoryMessage?(message: ChatMessage): void; onHistoryResync?(): Promise<void>;
} = {}) {
	const { locale } = useLocale();
	const { onHistoryMessage, onHistoryResync } = options;
	const scope = useMemo(() => ({ sessionId }), [sessionId]);
	const live = useRef<typeof scope | null>(scope);
	live.current = scope;
	const tasks = useDeploymentTasks(sessionId);
	const catalog = useDeploymentCatalog(sessionId);
	const { refresh: refreshMode, receive: receiveTask, updateRun: updateTaskRun, get: getTask, accept: acceptTask } = tasks;
	const { refresh: refreshCatalog, upsert: upsertRun } = catalog;
	const logs = useMemo(() => new DeploymentLogStore(sessionId), [sessionId]);
	const [view, setView] = useState({ scope, selection: initialSelection() });
	const [picker, setPicker] = useState({ scope, open: false, loading: false });
	const [discussions, setDiscussions] = useState<{ scope: typeof scope; values: Record<string, DeploymentDiscussion> }>({ scope, values: {} });
	const [failure, setFailure] = useState<{ scope: typeof scope; message: string | null }>({ scope, message: null });
	const [mutation, setMutation] = useState<{ scope: typeof scope; pending: boolean }>({ scope, pending: false });
	const intent = useRef({ scope, revision: 0, userSelected: false });
	if (intent.current.scope !== scope) intent.current = { scope, revision: 0, userSelected: false };
	const mutationLock = useRef<symbol | null>(null);
	const selection = view.scope === scope ? view.selection : initialSelection();
	const selectionRef = useRef(selection);
	selectionRef.current = selection;

	const setSelection = useCallback((change: (current: Selection) => Selection) => {
		if (live.current === scope) setView((current) => ({ scope, selection: change(current.scope === scope ? current.selection : initialSelection()) }));
	}, [scope]);
	const setError = useCallback((message: string | null) => {
		if (live.current === scope) setFailure({ scope, message });
	}, [scope]);
	const acceptRun = useCallback((run: DeploymentRun) => { upsertRun(run); updateTaskRun(run); }, [upsertRun, updateTaskRun]);
	const acceptDiscussion = useCallback((discussion: DeploymentDiscussion) => {
		if (live.current !== scope || discussion.sessionId !== sessionId) return;
		setDiscussions((prior) => {
			const values = prior.scope === scope ? prior.values : {};
			const saved = values[discussion.id];
			return saved && saved.updatedAt > discussion.updatedAt ? prior : { scope, values: { ...values, [discussion.id]: discussion } };
		});
	}, [scope, sessionId]);
	const loadDiscussion = useCallback(async (id: string) => {
		const discussion = await deploymentApi.getDiscussion(sessionId, id);
		acceptDiscussion(discussion);
		if (discussion.deploymentRunId) acceptRun(await deploymentApi.get(sessionId, discussion.deploymentRunId));
		return discussion;
	}, [acceptDiscussion, acceptRun, sessionId]);
	const refresh = useCallback(async () => {
		const [mode, discovered] = await Promise.allSettled([refreshMode(), refreshCatalog()]);
		if (live.current !== scope) return;
		if (mode.status === "fulfilled" && mode.value?.run) acceptRun(mode.value.run);
		if (discovered.status === "fulfilled" && discovered.value?.activeDiscussion) acceptDiscussion(discovered.value.activeDiscussion);
		for (const result of [mode, discovered]) if (result.status === "rejected") setError(message(result.reason));
		const selected = selectionRef.current.id;
		if (selected) {
			try {
				const task = await getTask(selected);
				if (task.run) acceptRun(task.run);
				else await loadDiscussion(selected);
			} catch (error) {
				if (notFound(error)) {
					try { acceptRun(await deploymentApi.get(sessionId, selected)); }
					catch (failure) {
						if (!notFound(failure)) setError(message(failure));
						else await loadDiscussion(selected).catch((error) => setError(message(error)));
					}
				} else setError(message(error));
			}
		}
	}, [acceptDiscussion, acceptRun, getTask, loadDiscussion, refreshCatalog, refreshMode, scope, sessionId, setError]);

	useEffect(() => {
		live.current = scope; mutationLock.current = null; logs.activate();
		return () => { if (live.current === scope) live.current = null; logs.dispose(); };
	}, [logs, scope]);
	useEffect(() => {
		if (!workspaceId) return;
		const observedStatuses = new Map<string, DeploymentRun["status"]>();
		return subscribeDeploymentEvents({ sessionId, workspaceId, locale, onRun: (run) => {
				acceptRun(run);
				if (observedStatuses.get(run.id) !== run.status) {
					observedStatuses.set(run.id, run.status);
					void onHistoryResync?.();
				}
			}, onDiscussion: acceptDiscussion,
			onTask: receiveTask, onLog: (chunk) => logs.append(chunk), onMessage: onHistoryMessage,
			onReconnect: () => { logs.refresh(); void refresh(); void onHistoryResync?.(); },
		});
	}, [acceptDiscussion, acceptRun, locale, logs, onHistoryMessage, onHistoryResync, receiveTask, refresh, sessionId, workspaceId]);

	const activeId = tasks.active?.deployment.id;
	const legacyDiscussion = catalog.discovery?.activeDiscussion;
	const legacyRun = catalog.discovery?.latest;
	useEffect(() => {
		if (!tasks.ready || intent.current.userSelected) return;
		const id = activeId ?? legacyDiscussion?.id ?? (legacyRun && ["preparing", "running", "recovering"].includes(legacyRun.status) ? legacyRun.id : null);
		if (!id) return;
		intent.current.userSelected = true;
		setSelection((current) => current.id === id && current.open ? current : { open: true, id, loading: false });
		if (legacyDiscussion?.id === id) acceptDiscussion(legacyDiscussion);
		else if (tasks.active && !tasks.active.run) void loadDiscussion(id).catch((error) => setError(message(error)));
	}, [activeId, tasks.ready, legacyDiscussion, legacyRun, acceptDiscussion, loadDiscussion, setError, setSelection]);

	const isCurrentIntent = (revision: number) => live.current === scope && intent.current.scope === scope && intent.current.revision === revision;
	const closePicker = () => {
		intent.current.userSelected = true; ++intent.current.revision;
		if (live.current === scope) setPicker({ scope, open: false, loading: false });
	};
	const select = (id: string | null, loading: boolean) => {
		intent.current.userSelected = true;
		const revision = ++intent.current.revision;
		setPicker({ scope, open: false, loading: false });
		setError(null); setSelection(() => ({ open: true, id, loading }));
		return revision;
	};
	const show = async (): Promise<"task" | "picker" | undefined> => {
		intent.current.userSelected = true;
		const revision = ++intent.current.revision;
		setError(null);
		setPicker({ scope, open: !tasks.active, loading: true });
		try {
			const task = await refreshMode();
			if (!isCurrentIntent(revision) || task === undefined) return;
			if (task) {
				setPicker({ scope, open: false, loading: false });
				setSelection(() => ({ open: true, id: task.deployment.id, loading: false }));
				if (task.run) acceptRun(task.run);
				else await loadDiscussion(task.deployment.id);
				return isCurrentIntent(revision) ? "task" : undefined;
			}
			setPicker({ scope, open: true, loading: true });
			await refreshCatalog();
			return isCurrentIntent(revision) ? "picker" : undefined;
		} catch (error) {
			if (isCurrentIntent(revision)) { setError(message(error)); setPicker({ scope, open: true, loading: false }); }
		}
		finally { if (isCurrentIntent(revision)) setPicker((current) => ({ ...current, loading: false })); }
	};
	const openHistory = async (id: string) => {
		const revision = select(id, true);
		try {
			try {
				const task = await getTask(id);
				if (task.run) acceptRun(task.run); else await loadDiscussion(id);
			} catch (error) {
				if (!notFound(error)) throw error;
				try { acceptRun(await deploymentApi.get(sessionId, id)); }
				catch (failure) { if (!notFound(failure)) throw failure; await loadDiscussion(id); }
			}
		} catch (error) { if (isCurrentIntent(revision)) setError(message(error)); }
		finally { if (isCurrentIntent(revision)) setSelection((current) => ({ ...current, loading: false })); }
	};
	const mutate = async <T,>(operation: () => Promise<T>): Promise<T | null> => {
		if (live.current !== scope || mutationLock.current) return null;
		const lock = Symbol("deployment mutation"); mutationLock.current = lock;
		setMutation({ scope, pending: true }); setError(null);
		try { return await operation(); }
		catch (error) { setError(message(error)); return null; }
		finally {
			if (live.current === scope && mutationLock.current === lock) { mutationLock.current = null; setMutation({ scope, pending: false }); }
		}
	};
	const beginDiscussion = (file: string, moduleId: string): Promise<DeploymentDiscussion | null> => {
		if (mutationLock.current) return Promise.resolve(null);
		const revision = ++intent.current.revision;
		intent.current.userSelected = true;
		return mutate(async () => {
			const discussion = await deploymentApi.beginDiscussion(sessionId, file, moduleId);
			const active = await refreshMode();
			acceptDiscussion(discussion);
			if (!isCurrentIntent(revision) || active?.deployment.id !== discussion.id) return null;
			setPicker({ scope, open: false, loading: false });
			setSelection(() => ({ open: true, id: discussion.id, loading: false }));
			return discussion;
		});
	};
	const selectedTask = selection.id ? tasks.tasks[selection.id] ?? null : null;
	const run = newestDeploymentRun(selectedTask?.run, catalog.runs.find((run) => run.id === selection.id || run.discussionId === selection.id));
	const selectedDiscussion = selection.id ? discussions.scope === scope ? discussions.values[selection.id] ?? null : null : null;
	const activeRun = tasks.active?.run ?? null;
	const act = (operation: (id: string) => Promise<DeploymentRun>) => activeRun ? mutate(async () => {
		const result = await operation(activeRun.id); acceptRun(result); return result;
	}) : Promise.resolve(null);
	return {
		open: selection.open, loading: selection.loading, pickerOpen: picker.scope === scope && picker.open,
		pickerLoading: picker.scope === scope && picker.loading, closePicker, busy: mutation.scope === scope && mutation.pending,
		discovery: catalog.discovery, run, selectedTask, selectedDiscussion, activeTask: tasks.active, logs,
		error: (failure.scope === scope ? failure.message : null) ?? tasks.error ?? catalog.error,
		show, openHistory, refresh, setError, beginDiscussion,
		hide: () => { closePicker(); setSelection((current) => ({ ...current, open: false, loading: false })); },
		finish: () => tasks.active ? mutate(async () => {
			const result = await deploymentApi.finish(sessionId, tasks.active!.deployment.id, "cancelled");
			acceptTask(result); if (result.run) acceptRun(result.run); return result;
		}) : Promise.resolve(null),
		decideFullAccess: (stage: DeploymentRemoteStage, id: string, approved: boolean) => act((runId) => deploymentApi.decideFullAccess(sessionId, runId, stage, id, approved)),
		decideRecovery: (id: string, approved: boolean) => act((runId) => deploymentApi.decideRecovery(sessionId, runId, id, approved)),
	};
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function notFound(value: unknown): boolean { return value instanceof ApiError && value.status === 404; }
