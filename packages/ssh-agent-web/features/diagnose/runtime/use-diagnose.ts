"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatRun } from "@/features/chat/model/chat";
import type { LlmModel, ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { diagnoseApi, type DiagnoseChatInput } from "../api/diagnose-api";
import { diagnoseCommand } from "../model/diagnose-command";
import { useDiagnoseTasks } from "./use-diagnose-tasks";
import { useDiagnoseView } from "./use-diagnose-view";

export function useDiagnose(options: { sessionId: string; workspaceId?: string; model: Pick<LlmModel, "id" | "providerId"> | null; thinkingLevel: ThinkingLevel;
	serverInteractionMode: "command" | "terminal"; attachRun(run: ChatRun): Promise<void>; onHistoryMessage(message: ChatMessage): void; onHistoryResync(): Promise<void> }) {
	const { sessionId } = options;
	const localizedError = useLocalizedErrorMessage();
	const [selectedTaskId, selectTask] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const scope = useRef({ sessionId });
	if (scope.current.sessionId !== sessionId) scope.current = { sessionId };
	const inFlight = useRef(new Set<string>());
	const selectionIntent = useRef(0);
	const retryRequests = useRef(new Map<string, string>());
	const tasks = useDiagnoseTasks(sessionId, options.workspaceId, selectedTaskId, options);
	const view = useDiagnoseView(sessionId);
	const recovered = useRef(false);
	useEffect(() => { selectTask(null); setOpen(false); setBusy(false); setError(null); inFlight.current.clear(); selectionIntent.current++; recovered.current = false; retryRequests.current.clear(); }, [sessionId]);
	useEffect(() => {
		if (tasks.activeTaskId && !recovered.current) { recovered.current = true; selectTask(tasks.activeTaskId); setOpen(true); }
	}, [tasks.activeTaskId]);
	const input = (requestId: string): DiagnoseChatInput => ({ requestId, ...(options.model ? { providerId: options.model.providerId, modelId: options.model.id } : {}),
		thinkingLevel: options.thinkingLevel, serverInteractionMode: options.serverInteractionMode });
	const perform = async (key: string, operation: (requestId: string) => Promise<void>): Promise<boolean> => {
		const directExit = key.startsWith("cancel:");
		if (inFlight.current.has(key) || !directExit && inFlight.current.size > 0) return false;
		const identity = scope.current;
		inFlight.current.add(key); setBusy(true); setError(null); tasks.setError(null);
		const requestId = retryRequests.current.get(key) ?? crypto.randomUUID(); retryRequests.current.set(key, requestId);
		try { await operation(requestId); if (scope.current !== identity) return false; retryRequests.current.delete(key); return true; }
		catch (failure) {
			if (scope.current === identity) {
				setError(failure);
				await Promise.allSettled([tasks.refresh(), options.onHistoryResync()]);
			}
			return false;
		}
		finally { if (scope.current === identity) { inFlight.current.delete(key); setBusy(inFlight.current.size > 0); } }
	};
	const show = async (problem = "", attachments: SessionAttachment[] = []): Promise<boolean> => {
		if (tasks.activeTaskId && !problem && !attachments.length) { selectTask(tasks.activeTaskId); setOpen(true); return true; }
		if (inFlight.current.size > 0) return false;
		const intent = ++selectionIntent.current; recovered.current = true;
		const identity = scope.current;
		const success = await perform(`start:${problem}:${attachments.map((item) => item.id).join(",")}`, async (requestId) => {
			const result = await diagnoseApi.start(sessionId, { ...input(requestId), problem, attachmentIds: attachments.map((item) => item.id) });
			if (scope.current !== identity) return;
			tasks.acceptTask(result.task);
			if (selectionIntent.current === intent) { selectTask(result.task.id); setOpen(true); }
			if (result.run) await options.attachRun(result.run);
			else await options.onHistoryResync();
			await tasks.load(result.task.id);
		});
		if (!success && scope.current === identity && selectionIntent.current === intent) {
			try {
				const active = await diagnoseApi.active(sessionId);
				if (active && scope.current === identity && selectionIntent.current === intent) { tasks.acceptTask(active); selectTask(active.id); setOpen(true); }
			} catch { /* Preserve the original action failure. */ }
		}
		return success && scope.current === identity && selectionIntent.current === intent;
	};
	const execute = async (message: string, attachments: SessionAttachment[]): Promise<boolean | null> => {
		const command = diagnoseCommand(message); return command ? show(command.problem, attachments) : null;
	};
	const conclude = () => selectedTaskId ? perform(`conclude:${selectedTaskId}`, async (requestId) => {
		const identity = scope.current;
		const result = await diagnoseApi.conclude(sessionId, selectedTaskId, input(requestId));
		if (scope.current !== identity) return;
		tasks.acceptTask(result.task); if (result.run) await options.attachRun(result.run);
	}) : Promise.resolve(false);
	const cancel = () => selectedTaskId ? perform(`cancel:${selectedTaskId}`, async () => {
		const identity = scope.current;
		const task = await diagnoseApi.cancel(sessionId, selectedTaskId);
		if (scope.current === identity) { tasks.acceptTask(task); await tasks.load(task.id); }
	}) : Promise.resolve(false);
	const openHistory = useCallback((id: string) => { selectionIntent.current++; recovered.current = true; selectTask(id); setOpen(true); }, []);
	return { open, busy, selectedTaskId, selected: selectedTaskId ? tasks.tasks[selectedTaskId] : undefined,
		activeTask: tasks.activeTaskId ? tasks.tasks[tasks.activeTaskId]?.task : undefined, loading: tasks.loading,
		error: error || tasks.error ? localizedError(error ?? tasks.error) : null, clearError: () => { setError(null); tasks.setError(null); }, show, execute, conclude, cancel, hide: () => { selectionIntent.current++; setOpen(false); }, openHistory,
		refresh: tasks.refresh, loadOlder: () => selectedTaskId ? tasks.load(selectedTaskId, true) : Promise.resolve(false), view };
}
