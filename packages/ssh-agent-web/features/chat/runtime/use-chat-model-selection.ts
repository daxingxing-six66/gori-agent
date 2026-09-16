"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import {
	chatModelRestoreReducer,
	initialChatModelRestoreState,
	resolveChatModelSelection,
} from "@/features/chat/model/chat-model-selection-restore";
import { activeChatRun } from "@/features/chat/model/chat-runtime-state";
import type { ChatRun } from "@/features/chat/model/chat";
import type { LlmModel, ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import { sessionApi } from "@/features/session/api/session-api";
import type { ChatModelSelection } from "@/features/session/model/session";

export function useChatModelSelection(sessionId: string, runtimeLoading: boolean, run: ChatRun | null) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [state, dispatch] = useReducer(chatModelRestoreReducer, sessionId, initialChatModelRestoreState);
	const [retryVersion, setRetryVersion] = useState(0);
	const requestTokenRef = useRef(0);
	const completedSessionRef = useRef<string | null>(null);
	const runRef = useRef(run);

	useEffect(() => {
		runRef.current = run;
	}, [run]);

	useEffect(() => {
		completedSessionRef.current = null;
		requestTokenRef.current += 1;
		dispatch({ type: "reset", sessionId, requestToken: requestTokenRef.current });
	}, [sessionId]);

	useEffect(() => {
		if (runtimeLoading || completedSessionRef.current === sessionId) return;
		if (runRef.current && runRef.current.sessionId !== sessionId) return;

		const controller = new AbortController();
		const requestToken = requestTokenRef.current + 1;
		requestTokenRef.current = requestToken;
		dispatch({ type: "reset", sessionId, requestToken });
		dispatch({ type: "start", sessionId, requestToken });

		void Promise.resolve().then(async () => {
			try {
				const activeRun = activeChatRun(runRef.current) ? runRef.current : null;
				const selection: ChatModelSelection | null = activeRun ?? (
					await sessionApi.get(sessionId, controller.signal)
				).chatModelSelection;
				const result = await resolveChatModelSelection(selection, controller.signal);
				if (controller.signal.aborted || requestTokenRef.current !== requestToken) return;

				if (result.status === "resolved") {
					dispatch({ type: "resolved", sessionId, requestToken, ...result });
				} else {
					dispatch({ type: result.status, sessionId, requestToken });
				}
				completedSessionRef.current = sessionId;
			} catch (requestError) {
				if (controller.signal.aborted || requestTokenRef.current !== requestToken) return;
				dispatch({ type: "failed", sessionId, requestToken, error: requestError });
			} finally {
				if (!controller.signal.aborted && requestTokenRef.current === requestToken) {
					dispatch({ type: "settled", sessionId, requestToken });
				}
			}
		});

		return () => {
			controller.abort();
			if (requestTokenRef.current === requestToken) requestTokenRef.current += 1;
		};
	}, [retryVersion, runtimeLoading, sessionId]);

	const retry = useCallback(() => {
		completedSessionRef.current = null;
		setRetryVersion((version) => version + 1);
	}, []);
	const selectModel = useCallback((model: LlmModel | null) => {
		dispatch({ type: "selectModel", model });
	}, []);
	const selectThinkingLevel = useCallback((thinkingLevel: ThinkingLevel) => {
		dispatch({ type: "selectThinkingLevel", thinkingLevel });
	}, []);

	const error = state.error === null
		? null
		: state.error.type === "model_unavailable"
			? intl.formatMessage({ id: "chat.model.unavailable" })
			: state.error.type === "thinking_level_unavailable"
				? intl.formatMessage({ id: "chat.model.thinkingUnavailable" })
				: localizedErrorMessage(state.error.cause);

	return { ...state, error, retry, selectModel, selectThinkingLevel };
}
