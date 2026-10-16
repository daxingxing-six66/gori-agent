import { describe, expect, it } from "vitest";
import { isUserDecision, type UserDecision } from "../features/chat/model/user-decision";

function decision(optionCount: number): UserDecision {
	return {
		id: "d", sessionId: "s", runId: "r", toolCallId: "t", status: "pending", createdAt: 1,
		questions: [{ question: "Choose a route", options: Array.from({ length: optionCount }, (_, index) => ({
			label: `Route ${index}`, description: "Route details",
		})), recommendedIndex: optionCount - 1 }],
	};
}

describe("user decision protocol validation", () => {
	it.each([1, 2, 3, 4, 5])("accepts pending and answered decisions with %i options", (optionCount) => {
		const pending = decision(optionCount);
		expect(isUserDecision(pending)).toBe(true);
		expect(isUserDecision({ ...pending, status: "answered", resolvedAt: 2, answers: [{ kind: "option", optionIndex: optionCount - 1 }] })).toBe(true);
		expect(isUserDecision({ ...pending, status: "answered", resolvedAt: 2, answers: [{ kind: "option", optionIndex: optionCount }] })).toBe(false);
	});

	it("validates answers against their own question's option count", () => {
		const five = decision(5);
		const one = decision(1);
		const answered = { ...five, questions: [...five.questions, ...one.questions], status: "answered", resolvedAt: 2 };
		expect(isUserDecision({ ...answered, answers: [{ kind: "option", optionIndex: 4 }, { kind: "option", optionIndex: 0 }] })).toBe(true);
		expect(isUserDecision({ ...answered, answers: [{ kind: "option", optionIndex: 4 }, { kind: "option", optionIndex: 1 }] })).toBe(false);
	});

	it("rejects empty options and invalid recommendations", () => {
		expect(isUserDecision(decision(0))).toBe(false);
		for (const recommendedIndex of [-1, 1, 0.5]) {
			const pending = decision(1);
			pending.questions[0]!.recommendedIndex = recommendedIndex;
			expect(isUserDecision(pending)).toBe(false);
		}
	});
});
