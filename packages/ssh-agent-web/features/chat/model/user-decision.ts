export interface UserDecisionOption { label: string; description: string }
export interface UserDecisionQuestion {
	question: string;
	options: UserDecisionOption[];
	recommendedIndex: number;
}
export type UserDecisionAnswer =
	| { kind: "option"; optionIndex: number }
	| { kind: "custom"; text: string }
	| { kind: "skipped" };
export interface UserDecision {
	id: string;
	sessionId: string;
	runId: string;
	toolCallId: string;
	questions: UserDecisionQuestion[];
	answers?: UserDecisionAnswer[];
	status: "pending" | "answered" | "cancelled" | "interrupted";
	createdAt: number;
	resolvedAt?: number;
}

export function isUserDecision(value: unknown): value is UserDecision {
	if (!record(value) || !text(value.id) || !text(value.sessionId) || !text(value.runId) || !text(value.toolCallId) ||
		!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 || !Array.isArray(value.questions) || value.questions.length === 0 ||
		new TextEncoder().encode(JSON.stringify(value.questions)).byteLength > 65_536 ||
		!value.questions.every(isQuestion) ||
		(value.status !== "pending" && value.status !== "answered" && value.status !== "cancelled" && value.status !== "interrupted")) return false;
	if (value.status === "pending") return value.answers === undefined && value.resolvedAt === undefined;
	const questions = value.questions;
	return Number.isSafeInteger(value.resolvedAt) && (value.resolvedAt as number) >= (value.createdAt as number) &&
		(value.status === "answered" ? Array.isArray(value.answers) && value.answers.length === questions.length &&
			value.answers.every((answer, index) => isAnswer(answer, questions[index]!.options.length)) : value.answers === undefined);
}

function isQuestion(value: unknown): value is UserDecisionQuestion {
	return record(value) && boundedText(value.question, 1_000) && Array.isArray(value.options) && value.options.length > 0 &&
		value.options.every((option) => record(option) && boundedText(option.label, 120) && boundedText(option.description, 500)) &&
		typeof value.recommendedIndex === "number" && Number.isInteger(value.recommendedIndex) && value.recommendedIndex >= 0 && value.recommendedIndex < value.options.length;
}

function isAnswer(value: unknown, optionCount: number): value is UserDecisionAnswer {
	if (!record(value)) return false;
	if (value.kind === "skipped") return Object.keys(value).length === 1;
	if (value.kind === "custom") return Object.keys(value).length === 2 && boundedText(value.text, 4_000);
	return value.kind === "option" && Object.keys(value).length === 2 &&
		typeof value.optionIndex === "number" && Number.isInteger(value.optionIndex) && value.optionIndex >= 0 && value.optionIndex < optionCount;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function boundedText(value: unknown, maxLength: number): value is string {
	return text(value) && value.length <= maxLength;
}
