"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/features/chat/model/chat";
import { useLocale } from "@/features/i18n/components/locale-context";
import { diagnoseApi } from "../api/diagnose-api";
import { mergeDiagnoseNodes, newerDiagnoseTask, type DiagnoseNode, type DiagnoseTask } from "../model/diagnose";
import { subscribeDiagnoseEvents } from "./diagnose-event-stream";

export interface DiagnoseCacheEntry { task?: DiagnoseTask; nodes: DiagnoseNode[]; nextBeforeSequence: number | null; loaded: boolean }
interface CacheState { sessionId: string; tasks: Record<string, DiagnoseCacheEntry>; activeTaskId: string | null }
const emptyEntry = (): DiagnoseCacheEntry => ({ nodes: [], nextBeforeSequence: null, loaded: false });

/** REST reconciliation and SSE share entity revisions; task revisions never gate node updates. */
export function useDiagnoseTasks(sessionId: string, workspaceId: string | undefined, selectedTaskId: string | null, callbacks: { onHistoryMessage(message: ChatMessage): void; onHistoryResync(): Promise<void> }) {
	const { locale } = useLocale();
	const [state, setState] = useState<CacheState>({ sessionId, tasks: {}, activeTaskId: null });
	const [error, setError] = useState<unknown>(null);
	const [loading, setLoading] = useState(false);
	const scope = useRef({ sessionId, workspaceId });
	const selectedRef = useRef(selectedTaskId); selectedRef.current = selectedTaskId;
	const stateRef = useRef(state); stateRef.current = state;
	const eventEpoch = useRef(0);
	const callbacksRef = useRef(callbacks); callbacksRef.current = callbacks;
	if (scope.current.sessionId !== sessionId || scope.current.workspaceId !== workspaceId) scope.current = { sessionId, workspaceId };
	const acceptTask = useCallback((task: DiagnoseTask) => {
		if (task.sessionId !== sessionId || scope.current.sessionId !== sessionId || task.workspaceId !== scope.current.workspaceId) return;
		setState((previous) => {
			const current = previous.sessionId === sessionId ? previous : { sessionId, tasks: {}, activeTaskId: null };
			const entry = current.tasks[task.id] ?? emptyEntry();
			const accepted = newerDiagnoseTask(entry.task, task);
			return { ...current, tasks: { ...current.tasks, [task.id]: { ...entry, task: accepted } },
				activeTaskId: accepted.status === "active" ? accepted.id : current.activeTaskId === accepted.id ? null : current.activeTaskId };
		});
	}, [sessionId]);
	const acceptNode = useCallback((node: DiagnoseNode) => {
		if (scope.current.sessionId !== sessionId) return;
		setState((previous) => {
			if (previous.sessionId !== sessionId) return previous;
			const entry = previous.tasks[node.taskId] ?? emptyEntry();
			return { ...previous, tasks: { ...previous.tasks, [node.taskId]: { ...entry, nodes: mergeDiagnoseNodes(entry.nodes, [node]) } } };
		});
	}, [sessionId]);
	const load = useCallback(async (taskId: string, older = false) => {
		const identity = scope.current;
		const previous = stateRef.current.sessionId === sessionId ? stateRef.current.tasks[taskId] : undefined;
		const cursor = older ? previous?.nextBeforeSequence : undefined;
		if (older && !cursor) return false;
		const knownSequence = previous?.nodes.at(-1)?.sequence ?? 0;
		try {
			const task = await diagnoseApi.get(sessionId, taskId);
			let page = await diagnoseApi.nodes(sessionId, taskId, cursor ?? undefined);
			let nodes = page.nodes;
			// Reconnect can miss more than one page. Fill the gap to the last known record.
			while (!older && knownSequence > 0 && page.nextBeforeSequence && page.nodes[0] && page.nodes[0].sequence > knownSequence + 1) {
				page = await diagnoseApi.nodes(sessionId, taskId, page.nextBeforeSequence);
				nodes = mergeDiagnoseNodes(nodes, page.nodes);
			}
			if (scope.current !== identity) return false;
			acceptTask(task);
			setState((current) => {
				if (current.sessionId !== sessionId) return current;
				const entry = current.tasks[taskId] ?? emptyEntry();
				const merged = mergeDiagnoseNodes(entry.nodes, nodes);
				const oldest = merged[0]?.sequence;
				return { ...current, tasks: { ...current.tasks, [taskId]: { ...entry, nodes: merged, loaded: true,
					nextBeforeSequence: oldest && oldest > 1 ? oldest : null } } };
			});
			return nodes.length > 0;
		} catch (failure) { if (scope.current === identity) setError(failure); return false; }
	}, [acceptTask, sessionId]);
	const refresh = useCallback(async () => {
		const identity = scope.current;
		const epoch = eventEpoch.current;
		try {
			const active = await diagnoseApi.active(sessionId);
			if (scope.current !== identity) return;
			if (active) acceptTask(active);
			else if (eventEpoch.current === epoch) setState((current) => current.sessionId === sessionId ? { ...current, activeTaskId: null } : current);
			await Promise.all([...new Set([active?.id, selectedRef.current].filter((id): id is string => !!id))].map((id) => load(id)));
		} catch (failure) { if (scope.current === identity) setError(failure); }
	}, [acceptTask, load, sessionId]);
	useEffect(() => {
		setState({ sessionId, tasks: {}, activeTaskId: null }); setError(null); setLoading(true);
		let disposed = false;
		void refresh().finally(() => { if (!disposed) setLoading(false); });
		return () => { disposed = true; };
	}, [sessionId, workspaceId, refresh]);
	useEffect(() => {
		if (!workspaceId) return;
		return subscribeDiagnoseEvents({ sessionId, workspaceId, locale,
			onTask: (task) => { eventEpoch.current++; acceptTask(task); }, onNode: acceptNode,
			onMessage: (message) => callbacksRef.current.onHistoryMessage(message),
			onReconnect: () => { void refresh(); void callbacksRef.current.onHistoryResync(); } });
	}, [sessionId, workspaceId, locale, acceptTask, acceptNode, refresh]);
	useEffect(() => { if (selectedTaskId) void load(selectedTaskId); }, [selectedTaskId, load]);
	return { tasks: state.sessionId === sessionId ? state.tasks : {}, activeTaskId: state.sessionId === sessionId ? state.activeTaskId : null,
		loading, error, setError, refresh, load, acceptTask };
}
