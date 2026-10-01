import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ChatRun } from "../../domain/chat.ts";
import { parseUserDecisionQuestions } from "../../domain/user-decision.ts";
import { decisionResult, type ChatUserDecisionService } from "../services/chat-user-decision-service.ts";

export const askUserDecisionParameters = Type.Object({
	questions: Type.Array(Type.Object({
		question: Type.String({ minLength: 1, maxLength: 1_000 }),
		options: Type.Array(Type.Object({
			label: Type.String({ minLength: 1, maxLength: 120 }),
			description: Type.String({ minLength: 1, maxLength: 500 }),
		}, { additionalProperties: false }), { minItems: 3, maxItems: 3 }),
		recommendedIndex: Type.Integer({ minimum: 0, maximum: 2 }),
	}, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export const askUserDecisionDefinition = {
	name: "ask_user_decision",
	label: "Ask user to decide",
	description: "Ask the user to choose between three mutually exclusive suggestions or write their own answer. Use when a user preference or decision is needed before continuing. Each question needs exactly three suggestions and one recommendedIndex. You may ask multiple questions. The user may skip a question. A choice does not bypass Guard or any subsequent tool approval.",
	parameters: askUserDecisionParameters,
};

export function createAskUserDecisionTool(options: {
	run: Pick<ChatRun, "id" | "sessionId">;
	decisions: Pick<ChatUserDecisionService, "request">;
}): AgentTool {
	return {
		...askUserDecisionDefinition,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal) => {
			const questions = parseUserDecisionQuestions((params as { questions: unknown }).questions);
			const answers = await options.decisions.request({ run: options.run, toolCallId, questions }, signal);
			return { content: [{ type: "text", text: JSON.stringify(decisionResult(questions, answers)) }], details: {} };
		},
	};
}
