export interface UserDecisionOption {
	label: string;
	description: string;
}

export interface UserDecisionQuestion {
	question: string;
	options: [UserDecisionOption, UserDecisionOption, UserDecisionOption];
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

const MAX_QUESTIONS_BYTES = 65_536;

export function parseUserDecisionQuestions(value: unknown): UserDecisionQuestion[] {
	if (!Array.isArray(value) || value.length === 0 || Buffer.byteLength(JSON.stringify(value)) > MAX_QUESTIONS_BYTES) {
		throw new Error("Decision questions must be a non-empty array within 64 KiB");
	}
	return value.map((entry) => {
		if (!record(entry, ["question", "options", "recommendedIndex"]) ||
			!validText(entry.question, 1_000) || !Array.isArray(entry.options) || entry.options.length !== 3 ||
			typeof entry.recommendedIndex !== "number" || !Number.isInteger(entry.recommendedIndex) || entry.recommendedIndex < 0 || entry.recommendedIndex > 2) {
			throw new Error("Invalid decision question");
		}
		const options = entry.options.map((option: unknown) => {
			if (!record(option, ["label", "description"]) || !validText(option.label, 120) ||
				!validText(option.description, 500)) throw new Error("Invalid decision option");
			return { label: option.label.trim(), description: option.description.trim() };
		}) as UserDecisionQuestion["options"];
		return { question: entry.question.trim(), options, recommendedIndex: entry.recommendedIndex };
	});
}

export function parseUserDecisionAnswers(value: unknown, questionCount: number): UserDecisionAnswer[] {
	if (!Array.isArray(value) || value.length !== questionCount) throw new Error("One answer is required for each question");
	return value.map((entry) => {
		if (!record(entry, ["kind", "optionIndex", "text"])) throw new Error("Invalid decision answer");
		if (entry.kind === "option" && Object.keys(entry).length === 2 &&
			typeof entry.optionIndex === "number" && Number.isInteger(entry.optionIndex) && entry.optionIndex >= 0 && entry.optionIndex < 3) {
			return { kind: "option", optionIndex: entry.optionIndex };
		}
		if (entry.kind === "custom" && Object.keys(entry).length === 2 && validText(entry.text, 4_000)) {
			return { kind: "custom", text: entry.text.trim() };
		}
		if (entry.kind === "skipped" && Object.keys(entry).length === 1) return { kind: "skipped" };
		throw new Error("Invalid decision answer");
	});
}

function record(value: unknown, allowed: string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		Object.keys(value).every((key) => allowed.includes(key));
}

function validText(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}
