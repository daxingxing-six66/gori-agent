import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRepository } from "../src/application/repositories/chat-repository.ts";
import { ChatUserDecisionService } from "../src/application/services/chat-user-decision-service.ts";
import { createAskUserDecisionTool } from "../src/application/tools/ask-user-decision-tool.ts";
import { parseUserDecisionQuestions, type UserDecision, type UserDecisionAnswer } from "../src/domain/user-decision.ts";
import { openSshAgentDatabase } from "../src/infrastructure/sqlite/database.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";

const questions = [
	{ question: "Choose a route", options: [
		{ label: "A", description: "First route" }, { label: "B", description: "Second route" },
		{ label: "C", description: "Third route" },
	], recommendedIndex: 1 },
	{ question: "Choose a format", options: [
		{ label: "Text", description: "Plain text" }, { label: "JSON", description: "Structured" },
		{ label: "Markdown", description: "Readable" },
	], recommendedIndex: 2 },
	{ question: "Anything else?", options: [
		{ label: "None", description: "No more" }, { label: "Later", description: "Decide later" },
		{ label: "Now", description: "Decide now" },
	], recommendedIndex: 0 },
];

function context() {
	const stored = new Map<string, UserDecision>();
	const repository = {
		insertDecision: (decision: UserDecision) => { stored.set(decision.id, decision); },
		findDecision: (sessionId: string, id: string) => stored.get(id)?.sessionId === sessionId ? stored.get(id) : undefined,
		listPendingDecisions: (sessionId: string) => [...stored.values()].filter((value) => value.sessionId === sessionId && value.status === "pending"),
		resolveDecision: (id: string, answers: UserDecisionAnswer[], resolvedAt: number) => {
			const current = stored.get(id);
			if (!current || current.status !== "pending") return undefined;
			const resolved: UserDecision = { ...current, answers, status: "answered", resolvedAt };
			stored.set(id, resolved);
			return resolved;
		},
		cancelPendingDecision: (id: string, status: "cancelled" | "interrupted", resolvedAt: number) => {
			const current = stored.get(id);
			if (!current || current.status !== "pending") return undefined;
			const resolved: UserDecision = { ...current, status, resolvedAt };
			stored.set(id, resolved);
			return resolved;
		},
	} satisfies Pick<ChatRepository, "insertDecision" | "findDecision" | "listPendingDecisions" | "resolveDecision" | "cancelPendingDecision">;
	const events = { publish: vi.fn() };
	let id = 0;
	const service = new ChatUserDecisionService({ repository, ids: { next: () => `decision-${++id}` }, events, clock: () => 100 });
	return { service, stored, events };
}

const request = { run: { id: "run-1", sessionId: "session-1" }, toolCallId: "tool-1", questions };

afterEach(() => vi.useRealTimers());

describe("Chat user decisions", () => {
	it("waits without a timeout and returns ordered option, custom, and skipped answers", async () => {
		vi.useFakeTimers();
		const { service, events } = context();
		const waiting = service.request(request);
		const settled = vi.fn();
		void waiting.then(settled);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(settled).not.toHaveBeenCalled();
		expect(service.listPending("session-1")).toHaveLength(1);
		expect(events.publish).toHaveBeenCalledWith("run-1", "decision.requested", expect.objectContaining({ id: "decision-1" }));
		const answers: UserDecisionAnswer[] = [{ kind: "option", optionIndex: 1 }, { kind: "custom", text: " YAML " }, { kind: "skipped" }];
		expect(service.answer("session-1", "decision-1", answers)).toMatchObject({ status: "answered" });
		await expect(waiting).resolves.toEqual([{ kind: "option", optionIndex: 1 }, { kind: "custom", text: "YAML" }, { kind: "skipped" }]);
		expect(service.answer("session-1", "decision-1", answers)).toMatchObject({ status: "answered" });
		expect(() => service.answer("session-1", "decision-1", [{ kind: "skipped" }, ...answers.slice(1)])).toThrow();
		expect(events.publish).toHaveBeenCalledWith("run-1", "decision.resolved", expect.objectContaining({ status: "answered" }));
	});

	it("rejects malformed, cross-session, and conflicting submissions", async () => {
		const { service } = context();
		const waiting = service.request(request);
		expect(() => service.answer("other-session", "decision-1", [])).toThrow();
		expect(() => service.answer("session-1", "decision-1", [{ kind: "option", optionIndex: 0 }])).toThrow();
		expect(() => service.answer("session-1", "decision-1", [
			{ kind: "option", optionIndex: 3 }, { kind: "skipped" }, { kind: "skipped" },
		])).toThrow();
		const answers: UserDecisionAnswer[] = [{ kind: "skipped" }, { kind: "skipped" }, { kind: "skipped" }];
		service.answer("session-1", "decision-1", answers);
		await waiting;
		expect(() => service.answer("session-1", "decision-1", [
			{ kind: "option", optionIndex: 0 }, ...answers.slice(1),
		])).toThrow();
	});

	it("cancels a waiting tool on abort or Run cancellation", async () => {
		const { service, stored } = context();
		const controller = new AbortController();
		const first = service.request(request, controller.signal);
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(stored.get("decision-1")?.status).toBe("cancelled");
		const second = service.request({ ...request, toolCallId: "tool-2" });
		service.cancelRun("run-1");
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(service.listPending("session-1")).toEqual([]);
	});

	it("marks a live wait interrupted when the backend closes", async () => {
		const { service, stored } = context();
		const waiting = service.request(request);
		service.close();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(stored.get("decision-1")?.status).toBe("interrupted");
		expect(() => service.answer("session-1", "decision-1", [
			{ kind: "skipped" }, { kind: "skipped" }, { kind: "skipped" },
		])).toThrow();
	});

	it("returns the chosen option text through the real Agent tool", async () => {
		const { service } = context();
		const tool = createAskUserDecisionTool({ run: request.run, decisions: service });
		const result = tool.execute("tool-1", { questions }, undefined);
		service.answer("session-1", "decision-1", [
			{ kind: "option", optionIndex: 1 }, { kind: "custom", text: "YAML" }, { kind: "skipped" },
		]);
		const output = await result;
		expect(JSON.parse((output.content[0] as { text: string }).text)).toMatchObject({ answers: [
			{ question: "Choose a route", kind: "option", option: { label: "B", description: "Second route" } },
			{ question: "Choose a format", kind: "custom", text: "YAML" },
			{ question: "Anything else?", kind: "skipped" },
		] });
	});

	it("validates question shape and rejects oversized payloads", () => {
		expect(() => parseUserDecisionQuestions([])).toThrow();
		expect(() => parseUserDecisionQuestions([{ ...questions[0], options: questions[0]!.options.slice(0, 2) }])).toThrow();
		expect(() => parseUserDecisionQuestions([{ ...questions[0], question: "x".repeat(70_000) }])).toThrow();
	});
});

describe("SQLite user decisions", () => {
	it("adds the decision table when upgrading an existing v21 schema", () => {
		const database = openSshAgentDatabase(":memory:");
		try {
			database.exec("DROP TABLE chat_user_decisions; DELETE FROM ssh_agent_schema_migrations WHERE version = 22");
			applyMigrations(database);
			expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_user_decisions'").get()).toBeDefined();
			applyMigrations(database);
		} finally { database.close(); }
	});

	it("migrates, recovers interrupted waits, and rejects corrupt persisted questions", () => {
		const database = openSshAgentDatabase(":memory:");
		try {
			database.exec("PRAGMA foreign_keys = OFF");
			const repository = new SqliteChatRepository(database);
			repository.insertDecision({ id: "d", sessionId: "s", runId: "r", toolCallId: "t",
				questions: parseUserDecisionQuestions(questions), status: "pending", createdAt: 1 });
			expect(repository.listPendingDecisions("s")).toHaveLength(1);
			repository.recoverInterrupted(2);
			expect(repository.findDecision("s", "d")).toMatchObject({ status: "interrupted", resolvedAt: 2 });
			database.prepare("UPDATE chat_user_decisions SET questions_json = ? WHERE id = 'd'").run("{}");
			expect(() => repository.findDecision("s", "d")).toThrow("Invalid persisted Chat decision data");
			database.prepare("UPDATE chat_user_decisions SET questions_json = ?, status = 'answered', answers_json = ? WHERE id = 'd'")
			.run(JSON.stringify(questions), "{}");
			expect(() => repository.findDecision("s", "d")).toThrow("Invalid persisted Chat decision data");
		} finally { database.close(); }
	});
});
