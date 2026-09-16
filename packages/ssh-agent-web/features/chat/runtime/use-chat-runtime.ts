"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ChatContextUsageStore } from "@/features/chat/runtime/chat-context-usage-store";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { useLocale } from "@/features/i18n/components/locale-context";
import { chatApi } from "@/features/chat/api/chat-api";
import {
	activeChatRun,
	chatRuntimeReducer,
	initialChatRuntimeState,
	type ChatRuntimeState,
} from "@/features/chat/model/chat-runtime-state";
import type { ChatMessage, ChatQueueBehavior, ChatRun, ManualChatCompactionResult, ToolApproval } from "@/features/chat/model/chat";
import { ChatEventStream } from "@/features/chat/runtime/chat-event-stream";
import type { LlmModel, ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";

interface SubmitInput {
	message: string;
	attachments: SessionAttachment[];
	model: Pick<LlmModel, "id" | "providerId"> | null;
	thinkingLevel: ThinkingLevel;
	behavior: ChatQueueBehavior;
	serverInteractionMode: "command" | "terminal";
}

export function useChatRuntime(sessionId: string) {
	const localizedErrorMessage = useLocalizedErrorMessage();
	const { locale } = useLocale();
	const contextUsageStore = useMemo(() => new ChatContextUsageStore((signal) => chatApi.getContextUsage(sessionId, signal)), [sessionId]);
	const contextUsage = useSyncExternalStore(contextUsageStore.subscribe, contextUsageStore.getSnapshot, contextUsageStore.getSnapshot);
	const [state, dispatch] = useReducer(chatRuntimeReducer, initialChatRuntimeState);
	const [loading, setLoading] = useState(true);
	const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
	const [nextBeforeSequence, setNextBeforeSequence] = useState<number | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [manualCompactionResult, setManualCompactionResult] = useState<ManualChatCompactionResult | null>(null);
	const [queueMutationId, setQueueMutationId] = useState<string | null>(null);
	const [approvalMutationId, setApprovalMutationId] = useState<string | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const stateRef = useRef<ChatRuntimeState>(state);
	const compactionControllerRef = useRef<AbortController | null>(null);
	const olderMessagesRequestRef = useRef(false);
	const queueMutationRef = useRef<symbol | null>(null);
	useEffect(() => {
		queueMutationRef.current = null;
		setQueueMutationId(null);
		return () => { queueMutationRef.current = null; };
	}, [sessionId]);
	useEffect(() => { stateRef.current = state; }, [state]);
	useEffect(() => () => {
		compactionControllerRef.current?.abort();
		compactionControllerRef.current = null;
	}, [sessionId]);

	const synchronize = useCallback(async (options: { afterSequence?: number; merge: boolean }) => {
		const page = options.afterSequence === undefined
			? await chatApi.listMessages(sessionId, { limit: 100 })
			: { messages: await listMessagePages(sessionId, options.afterSequence), nextBeforeSequence: null };
		const activeRun = await chatApi.getActiveRun(sessionId);
		const [approvals, queue] = await Promise.allSettled([
			chatApi.listApprovals(sessionId),
			activeRun.run ? chatApi.listQueue(sessionId, activeRun.run.id) : Promise.resolve({ items: [] }),
		]);
		dispatch({
			type: options.merge ? "mergePersisted" : "hydrate",
			messages: page.messages,
			approvals: approvals.status === "fulfilled" ? approvals.value.approvals : [],
		});
		if (options.afterSequence === undefined) setNextBeforeSequence(page.nextBeforeSequence);
		dispatch({ type: "setRun", run: activeRun.run });
		if (queue.status === "fulfilled") dispatch({ type: "hydrateQueue", items: queue.value.items, replace: true });
		if (approvals.status === "rejected") throw approvals.reason;
		if (queue.status === "rejected") throw queue.reason;
	}, [sessionId]);

	useEffect(() => {
		let cancelled = false;
		void Promise.resolve().then(async () => {
			if (cancelled) return;
			setManualCompactionResult(null);
			setCompacting(false);
			setLoadingOlderMessages(false);
			setNextBeforeSequence(null);
			olderMessagesRequestRef.current = false;
			setLoading(true);
			setRequestError(null);
			dispatch({ type: "reset" });
			try {
				await synchronize({ merge: false });
			} catch (requestError) {
				if (!cancelled) setRequestError(requestError);
			} finally {
				if (!cancelled) setLoading(false);
			}
		});
		return () => { cancelled = true; };
	}, [synchronize]);

	const loadOlderMessages = useCallback(async (): Promise<boolean> => {
		const beforeSequence = nextBeforeSequence;
		if (beforeSequence === null || olderMessagesRequestRef.current) return false;
		olderMessagesRequestRef.current = true;
		setLoadingOlderMessages(true);
		setRequestError(null);
		try {
			const page = await chatApi.listMessages(sessionId, { beforeSequence, limit: 100 });
			dispatch({ type: "mergePersisted", messages: page.messages });
			setNextBeforeSequence((current) => current === beforeSequence ? page.nextBeforeSequence : current);
			return page.messages.length > 0;
		} catch (requestError) {
			setRequestError(requestError);
			return false;
		} finally {
			olderMessagesRequestRef.current = false;
			setLoadingOlderMessages(false);
		}
	}, [nextBeforeSequence, sessionId]);

	const runId = activeChatRun(state.run) ? state.run?.id ?? null : null;
	useLayoutEffect(() => {
		if (!loading) void contextUsageStore.refresh();
		return contextUsageStore.cancel;
	}, [contextUsageStore, loading, runId]);
	useEffect(() => {
		if (!runId) return;
		let readyCount = 0;
		const stream = new ChatEventStream(sessionId, runId, locale);
		const unsubscribeConnection = stream.subscribeConnection((connection) => dispatch({ type: "connection", connection }));
		let synchronizing = false;
		const unsubscribe = stream.subscribe((event) => {
			if (event.type === "stream.resync" || event.type === "run.persistence_failed") {
				if (event.type === "run.persistence_failed") setRequestError(new Error(event.data.failure.message));
				if (!synchronizing) {
					synchronizing = true;
					void synchronize({ afterSequence: stateRef.current.maxSequence, merge: true }).catch(setRequestError).finally(() => { synchronizing = false; });
				}
				return;
			}
			if (event.type === "context.updated") {
				contextUsageStore.apply(event.data);
				return;
			}
			dispatch({ type: "event", event });
			if (event.type === "compaction.completed") {
				void synchronize({ afterSequence: stateRef.current.maxSequence, merge: true }).catch(setRequestError);
			}
			if (event.type === "stream.ready") {
				readyCount += 1;
				if (readyCount > 1) {
					void contextUsageStore.refresh();
					void synchronize({ afterSequence: stateRef.current.maxSequence, merge: true }).catch(setRequestError);
				}
			}
		});
		return () => {
			unsubscribe();
			unsubscribeConnection();
			stream.close();
		};
	}, [contextUsageStore, locale, runId, sessionId, synchronize]);

	const submit = useCallback(async ({ message, attachments, model, thinkingLevel, behavior, serverInteractionMode }: SubmitInput): Promise<ChatRun | null> => {
		const normalized = message.trim();
		const attachmentIds = attachments.map((attachment) => attachment.id);
		if ((!normalized && attachmentIds.length === 0) || submitting) return null;
		const requestId = crypto.randomUUID();
		setSubmitting(true);
		setRequestError(null);
		try {
			const currentRun = stateRef.current.run;
			if (activeChatRun(currentRun)) {
				const queued = await chatApi.enqueue(sessionId, currentRun.id, { requestId, behavior, message: normalized, attachmentIds });
				dispatch({
					type: "event",
					event: { type: "queue.updated", data: { id: queued.id, behavior, message: normalized, status: "pending" } },
				});
				return null;
			} else {
				if (!model) throw new Error("A model is required to create a Chat Run");
				dispatch({ type: "optimisticUser", requestId, message: normalized, attachments, timestamp: Date.now() });
				const run = await chatApi.createRun(sessionId, {
					requestId,
					providerId: model.providerId,
					modelId: model.id,
					thinkingLevel,
					message: normalized,
					attachmentIds,
					serverInteractionMode,
				});
				dispatch({ type: "setRun", run });
				return run;
			}
		} catch (requestError) {
			dispatch({ type: "removeOptimistic", requestId });
			setRequestError(requestError);
			throw requestError;
		} finally {
			setSubmitting(false);
		}
	}, [sessionId, submitting]);

	const cancel = useCallback(async (): Promise<void> => {
		const currentRun = stateRef.current.run;
		if (!activeChatRun(currentRun) || cancelling) return;
		setCancelling(true);
		setRequestError(null);
		try {
			dispatch({ type: "setRun", run: await chatApi.cancelRun(sessionId, currentRun.id) });
			dispatch({ type: "clearPendingRuntime" });
			await synchronize({ afterSequence: stateRef.current.maxSequence, merge: true });
		} catch (requestError) {
			setRequestError(requestError);
		} finally {
			setCancelling(false);
		}
	}, [cancelling, sessionId, synchronize]);

	const resolveApproval = useCallback(async (approval: ToolApproval, approved: boolean): Promise<void> => {
		if (approvalMutationId) return;
		setApprovalMutationId(approval.id);
		setRequestError(null);
		try {
			const resolved = await chatApi.resolveApproval(sessionId, approval.id, approved);
			dispatch({ type: "event", event: { type: "approval.resolved", data: resolved } });
		} catch (requestError) {
			setRequestError(requestError);
		} finally {
			setApprovalMutationId(null);
		}
	}, [approvalMutationId, sessionId]);

	const mutateQueued = useCallback(async (queueItemId: string, action: "cancel" | "steer"): Promise<void> => {
		const currentRun = stateRef.current.run;
		if (!activeChatRun(currentRun) || queueMutationRef.current) return;
		const mutation = Symbol();
		queueMutationRef.current = mutation;
		setQueueMutationId(queueItemId);
		setRequestError(null);
		try {
			const promoted = action === "steer" ? await chatApi.promoteQueued(sessionId, currentRun.id, queueItemId) : null;
			if (action === "cancel") await chatApi.cancelQueued(sessionId, currentRun.id, queueItemId);
			if (queueMutationRef.current !== mutation || stateRef.current.run?.id !== currentRun.id) return;
			// The reducer preserves terminal status when a consumed SSE event precedes this response.
			dispatch({ type: "event", event: { type: "queue.updated", data: promoted ? { id: promoted.id, behavior: promoted.behavior, status: promoted.status } : { id: queueItemId, status: "cancelled" } } });
		} catch (requestError) {
			if (queueMutationRef.current !== mutation || stateRef.current.run?.id !== currentRun.id) return;
			setRequestError(requestError);
			try {
				const queue = await chatApi.listQueue(sessionId, currentRun.id);
				if (queueMutationRef.current === mutation && stateRef.current.run?.id === currentRun.id) dispatch({ type: "hydrateQueue", items: queue.items, replace: true });
			} catch {
				// Keep the operation error visible when the recovery query also fails.
			}
		} finally {
			if (queueMutationRef.current === mutation) {
				queueMutationRef.current = null;
				setQueueMutationId(null);
			}
		}
	}, [sessionId]);
	const cancelQueued = useCallback((id: string) => mutateQueued(id, "cancel"), [mutateQueued]);
	const promoteQueued = useCallback((id: string) => mutateQueued(id, "steer"), [mutateQueued]);

	const compact = useCallback(async (): Promise<ManualChatCompactionResult | null> => {
		if (activeChatRun(stateRef.current.run) || compactionControllerRef.current) return null;
		const controller = new AbortController();
		compactionControllerRef.current = controller;
		setCompacting(true);
		setManualCompactionResult(null);
		setRequestError(null);
		try {
			const result = await chatApi.compact(sessionId, controller.signal);
			if (compactionControllerRef.current !== controller) return null;
			if (result.status === "completed") {
				dispatch({ type: "mergePersisted", messages: [result.message] });
			}
			setManualCompactionResult(result);
			contextUsageStore.apply(result.contextUsage);
			return result;
		} catch (requestError) {
			if (!controller.signal.aborted && compactionControllerRef.current === controller) {
				setRequestError(requestError);
				void contextUsageStore.refresh();
			}
			return null;
		} finally {
			if (compactionControllerRef.current === controller) {
				compactionControllerRef.current = null;
				setCompacting(false);
			}
		}
	}, [contextUsageStore, sessionId]);

	return {
		contextUsage,
		state,
		loading,
		loadingOlderMessages,
		hasOlderMessages: nextBeforeSequence !== null,
		submitting,
		cancelling,
		compacting,
		manualCompactionResult,
		queueMutationId,
		approvalMutationId,
		error: requestError === null ? null : localizedErrorMessage(requestError),
		setError: setRequestError,
		submit,
		cancel,
		resolveApproval,
		cancelQueued,
		promoteQueued,
		loadOlderMessages,
		compact,
		clearManualCompactionResult: () => setManualCompactionResult(null),
	};
}

async function listMessagePages(sessionId: string, afterSequence: number): Promise<ChatMessage[]> {
	const messages: ChatMessage[] = [];
	let cursor = afterSequence;
	for (;;) {
		const response = await chatApi.listMessages(sessionId, { afterSequence: cursor, limit: 100 });
		messages.push(...response.messages);
		if (response.nextSequence === null || response.messages.length === 0) return messages;
		cursor = response.messages.at(-1)?.sequence ?? cursor;
	}
}
