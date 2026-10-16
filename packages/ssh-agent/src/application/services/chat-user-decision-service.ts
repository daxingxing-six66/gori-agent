import { ChatError, type ChatRun } from "../../domain/chat.ts";
import type { IdGenerator } from "../../domain/ids.ts";
import {
	parseUserDecisionAnswers,
	parseUserDecisionQuestions,
	type UserDecision,
	type UserDecisionAnswer,
	type UserDecisionQuestion,
} from "../../domain/user-decision.ts";
import type { ChatEventPublisher } from "../chat-run-event-hub.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";

type DecisionRepository = Pick<ChatRepository,
	"insertDecision" | "findDecision" | "listPendingDecisions" | "resolveDecision" | "cancelPendingDecision">;

interface PendingDecision {
	runId: string;
	answer(answers: UserDecisionAnswer[]): void;
	cancel(error: Error): void;
}

/** Owns live waits; SQLite remains the source of truth for UI recovery and audit. */
export class ChatUserDecisionService {
	readonly #repository: DecisionRepository;
	readonly #ids: IdGenerator;
	readonly #events: ChatEventPublisher;
	readonly #clock: () => number;
	readonly #pending = new Map<string, PendingDecision>();

	constructor(options: { repository: DecisionRepository; ids: IdGenerator; events: ChatEventPublisher; clock?: () => number }) {
		this.#repository = options.repository;
		this.#ids = options.ids;
		this.#events = options.events;
		this.#clock = options.clock ?? Date.now;
	}

	request(input: { run: Pick<ChatRun, "id" | "sessionId">; toolCallId: string; questions: unknown }, signal?: AbortSignal): Promise<UserDecisionAnswer[]> {
		if (signal?.aborted) return Promise.reject(abortError());
		const questions = parseUserDecisionQuestions(input.questions);
		const decision: UserDecision = {
			id: this.#ids.next(), sessionId: input.run.sessionId, runId: input.run.id,
			toolCallId: input.toolCallId, questions, status: "pending", createdAt: this.#clock(),
		};
		this.#repository.insertDecision(decision);
		return new Promise<UserDecisionAnswer[]>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(decision.id);
			};
			const onAbort = () => {
				if (settled) return;
				try {
					const cancelled = this.#repository.cancelPendingDecision(decision.id, "cancelled", this.#clock());
					if (cancelled) this.#events.publish(decision.runId, "decision.resolved", cancelled);
					cleanup();
					reject(abortError());
				} catch (error) {
					cleanup();
					reject(error);
				}
			};
			this.#pending.set(decision.id, {
				runId: decision.runId,
				answer: (answers) => { if (!settled) { cleanup(); resolve(answers); } },
				cancel: (error) => { if (!settled) { cleanup(); reject(error); } },
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			else this.#events.publish(decision.runId, "decision.requested", decision);
		});
	}

	listPending(sessionId: string): UserDecision[] {
		return this.#repository.listPendingDecisions(sessionId);
	}

	answer(sessionId: string, decisionId: string, value: unknown): UserDecision {
		const current = this.#repository.findDecision(sessionId, decisionId);
		if (!current) throw new ChatError("decision_not_found", "User decision not found", 404);
		let answers: UserDecisionAnswer[];
		try { answers = parseUserDecisionAnswers(value, current.questions); }
		catch (cause) { throw new ChatError("decision_answer_invalid", "Invalid user decision answers", 400, { cause }); }
		if (current.status === "answered") {
			if (JSON.stringify(current.answers) === JSON.stringify(answers)) return current;
			throw new ChatError("decision_already_answered", "User decision already has different answers", 409);
		}
		if (current.status !== "pending" || this.#pending.get(decisionId)?.runId !== current.runId) {
			throw new ChatError("decision_not_pending", "User decision is no longer pending", 409);
		}
		const resolved = this.#repository.resolveDecision(decisionId, answers, this.#clock());
		if (!resolved) throw new ChatError("decision_not_pending", "User decision is no longer pending", 409);
		this.#pending.get(decisionId)?.answer(answers);
		this.#events.publish(resolved.runId, "decision.resolved", resolved);
		return resolved;
	}

	cancelRun(runId: string): void {
		this.#finishRun(runId, "cancelled");
	}

	close(): void {
		for (const runId of new Set([...this.#pending.values()].map((pending) => pending.runId))) {
			this.#finishRun(runId, "interrupted");
		}
	}

	#finishRun(runId: string, status: "cancelled" | "interrupted"): void {
		for (const [id, pending] of [...this.#pending]) {
			if (pending.runId !== runId) continue;
			const cancelled = this.#repository.cancelPendingDecision(id, status, this.#clock());
			if (cancelled) this.#events.publish(runId, "decision.resolved", cancelled);
			pending.cancel(abortError());
		}
	}
}

export function decisionResult(questions: UserDecisionQuestion[], answers: UserDecisionAnswer[]) {
	return { answers: answers.map((answer, index) => ({
		question: questions[index]!.question,
		...(answer.kind === "option" ? { kind: answer.kind, optionIndex: answer.optionIndex,
			option: questions[index]!.options[answer.optionIndex] } : answer),
	})) };
}

function abortError(): Error {
	return new DOMException("User decision wait was cancelled", "AbortError");
}
