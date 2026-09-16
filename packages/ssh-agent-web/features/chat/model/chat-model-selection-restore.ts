import type { ChatModelSelection } from "@/features/session/model/session";
import { resolveConfiguredModel } from "@/features/llm-provider/api/llm-provider-api";
import {
	thinkingLevelForModel,
	type LlmModel,
	type ThinkingLevel,
} from "@/features/llm-provider/model/llm-provider";

export type ChatModelRestoreResult =
	| { status: "empty" }
	| { status: "unavailable" }
	| {
		status: "resolved";
		model: LlmModel;
		thinkingLevel: ThinkingLevel;
		thinkingLevelChanged: boolean;
	};

export interface ChatModelRestoreState {
	sessionId: string;
	requestToken: number;
	model: LlmModel | null;
	thinkingLevel: ThinkingLevel;
	loading: boolean;
	error: ChatModelRestoreError | null;
	errorRetryable: boolean;
}

export type ChatModelRestoreError =
	| { type: "model_unavailable" }
	| { type: "thinking_level_unavailable" }
	| { type: "request_failed"; cause: unknown };

export type ChatModelRestoreAction =
	| { type: "reset"; sessionId: string; requestToken: number }
	| { type: "start"; sessionId: string; requestToken: number }
	| { type: "empty"; sessionId: string; requestToken: number }
	| { type: "unavailable"; sessionId: string; requestToken: number }
	| {
		type: "resolved";
		sessionId: string;
		requestToken: number;
		model: LlmModel;
		thinkingLevel: ThinkingLevel;
		thinkingLevelChanged: boolean;
	}
	| { type: "failed"; sessionId: string; requestToken: number; error: unknown }
	| { type: "settled"; sessionId: string; requestToken: number }
	| { type: "selectModel"; model: LlmModel | null }
	| { type: "selectThinkingLevel"; thinkingLevel: ThinkingLevel };

export function initialChatModelRestoreState(sessionId: string): ChatModelRestoreState {
	return {
		sessionId,
		requestToken: 0,
		model: null,
		thinkingLevel: "off",
		loading: true,
		error: null,
		errorRetryable: false,
	};
}

export function chatModelRestoreReducer(
	state: ChatModelRestoreState,
	action: ChatModelRestoreAction,
): ChatModelRestoreState {
	if (action.type === "selectModel") {
		return {
			...state,
			model: action.model,
			thinkingLevel: action.model
				? thinkingLevelForModel(action.model, state.thinkingLevel)
				: "off",
			error: null,
			errorRetryable: false,
		};
	}
	if (action.type === "selectThinkingLevel") {
		return { ...state, thinkingLevel: action.thinkingLevel };
	}
	if (action.type === "reset") {
		return {
			...initialChatModelRestoreState(action.sessionId),
			requestToken: action.requestToken,
		};
	}
	if (action.sessionId !== state.sessionId || action.requestToken !== state.requestToken) return state;

	switch (action.type) {
		case "start":
			return { ...state, loading: true, error: null, errorRetryable: false };
		case "empty":
			return { ...state, model: null, thinkingLevel: "off", error: null, errorRetryable: false };
		case "unavailable":
			return {
				...state,
				model: null,
				thinkingLevel: "off",
				error: { type: "model_unavailable" },
				errorRetryable: false,
			};
		case "resolved":
			return {
				...state,
				model: action.model,
				thinkingLevel: action.thinkingLevel,
				error: action.thinkingLevelChanged ? { type: "thinking_level_unavailable" } : null,
				errorRetryable: false,
			};
		case "failed":
			return { ...state, model: null, thinkingLevel: "off", error: { type: "request_failed", cause: action.error }, errorRetryable: true };
		case "settled":
			return { ...state, loading: false };
	}
}

export async function resolveChatModelSelection(
	selection: ChatModelSelection | null,
	signal: AbortSignal,
	resolveModel: (
		selection: Pick<ChatModelSelection, "providerId" | "modelId">,
		signal: AbortSignal,
	) => Promise<LlmModel | null> = resolveConfiguredModel,
): Promise<ChatModelRestoreResult> {
	if (!selection) return { status: "empty" };
	const model = await resolveModel(selection, signal);
	if (!model) return { status: "unavailable" };
	const thinkingLevel = thinkingLevelForModel(model, selection.thinkingLevel);
	return {
		status: "resolved",
		model,
		thinkingLevel,
		thinkingLevelChanged: thinkingLevel !== selection.thinkingLevel,
	};
}
