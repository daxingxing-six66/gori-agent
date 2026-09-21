import type { AgentMessage, compact } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ChatEventPublisher } from "../src/application/chat-run-event-hub.ts";
import type { ChatRepository, StoredChatCompaction } from "../src/application/repositories/chat-repository.ts";
import type { ChatAttachmentService } from "../src/application/services/chat-attachment-service.ts";
import { ChatContextService } from "../src/application/services/chat-context-service.ts";
import type { ChatMessageProjection, ChatRun } from "../src/domain/chat.ts";
import { createChatUserMessage } from "../src/domain/chat-attachment.ts";
import type { StoredChatCompactionMessage } from "../src/domain/context-compaction.ts";

type ContextRepository = Pick<ChatRepository, "appendCompaction" | "latestCompaction" | "listMessages" | "latestSystemMessage">;

const run: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "request-1",
	providerId: "provider",
	modelId: "model",
	thinkingLevel: "off",
	serverInteractionMode: "command",
	terminalSessionId: null,
	status: "running",
	createdAt: 1,
	updatedAt: 1,
};

function projection(sequence: number, message: AgentMessage): ChatMessageProjection {
	return {
		id: `message-${sequence}`,
		sequence,
		runId: "run-1",
		message,
		createdAt: message.timestamp,
	};
}

function createRepository(initial: ChatMessageProjection[]): {
	repository: ContextRepository;
	compactions: StoredChatCompactionMessage[];
} {
	const messages = [...initial];
	const compactions: StoredChatCompactionMessage[] = [];
	const repository: ContextRepository = {
		latestSystemMessage: () => [...messages].reverse().find((entry) => entry.message.role === "system"),
		listMessages: vi.fn((_sessionId: string, afterSequence = 0) =>
			messages.filter((message) => message.sequence > afterSequence),
		),
		latestCompaction: vi.fn(() => {
			let compact: ChatMessageProjection | undefined;
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				if (messages[index]?.message.role === "compactionSummary") {
					compact = messages[index];
					break;
				}
			}
			if (!compact) return undefined;
			return {
				id: compact.id,
				sequence: compact.sequence,
				runId: compact.runId,
				message: compact.message as StoredChatCompactionMessage,
				createdAt: compact.createdAt,
			} satisfies StoredChatCompaction;
		}),
		appendCompaction: vi.fn((id, _sessionId, runId, message, createdAt) => {
			const inserted: ChatMessageProjection = {
				id,
				sequence: (messages.at(-1)?.sequence ?? 0) + 1,
				...(runId === null ? {} : { runId }),
				message,
				createdAt,
			};
			messages.push(inserted);
			compactions.push(message);
			return inserted;
		}),
	};
	return { repository, compactions };
}

function createService(
	repository: ContextRepository,
	options: {
		compact?: typeof compact;
		events?: ChatEventPublisher;
		attachments?: Pick<ChatAttachmentService, "compactionProjection" | "restoreCompactionMessage">;
		contextWindow?: number;
		provider?: string;
		log?: (event: Record<string, unknown>) => void;
	} = {},
) {
	const faux = fauxProvider({
		provider: options.provider ?? "chat-context-test",
		models: [{ id: "small-context", contextWindow: options.contextWindow ?? 1_000, maxTokens: 256 }],
	});
	const models = Object.create(createModels()) as Models;
	models.checkAuth = async () => ({ source: "test", type: "api_key" });
	return {
		model: faux.getModel(),
		service: new ChatContextService({
			repository,
			models,
			catalog: { getModel: () => faux.getModel() },
			ids: { next: () => "compaction-1" },
			events: options.events ?? { publish: vi.fn() },
			attachments: options.attachments ?? {
				compactionProjection: (message) => message,
				restoreCompactionMessage: (message) => message,
			},
			clock: () => 500,
			compact: options.compact,
			log: options.log ?? vi.fn(),
		}),
	};
}

describe("ChatContextService", () => {
	it.each([false, true])("preserves authoritative mode across compaction (transition during summary: %s)", async (duringSummary) => {
		const mode = { role: "system" as const, runtimeEventId: "mode-on", runtimeMode: "terminal",
			content: [{ type: "text" as const, text: "<terminal-model-on>" }], timestamp: 1 };
		const off = { ...mode, runtimeEventId: "mode-off", runtimeMode: "command",
			content: [{ type: "text" as const, text: "<terminal-model-off>" }], timestamp: 4 };
		const old = createChatUserMessage("history".repeat(4000), [], 2);
		const recent = fauxAssistantMessage("recent", { timestamp: 3 });
		const { repository, compactions } = createRepository([projection(1, mode), projection(2, old), projection(3, recent)]);
		const { service, model } = createService(repository, { compact: async () => {
			if (duringSummary) repository.latestSystemMessage = () => projection(4, off);
			return { ok: true, value: { summary: "summary containing <terminal-model-off>", tokensBefore: 8000, retainedTail: [recent] } };
		} });
		const context = { systemPrompt: "immutable snapshot", messages: [mode, old, recent], tools: [] };
		const outcome = await service.compactContext({ sessionId: "session-1", run: null, context,
			sessionModel: model, settings: { triggerPercent: 80, model: null, revision: 1, updatedAt: 1 }, reason: "manual", force: true });
		expect(outcome.context.systemPrompt).toBe(context.systemPrompt);
		expect(compactions[0]?.retainedTail).toEqual(duringSummary ? [mode, recent, off] : [mode, recent]);
		expect(service.load("session-1")).toEqual(outcome.context.messages);
		expect(service.synchronizeRuntimeMode("session-1", outcome.context, duringSummary ? "command" : "terminal")).toBe(outcome.context);
		if (duringSummary) expect(() => service.synchronizeRuntimeMode("session-1", outcome.context, "terminal"))
			.toThrow("Server interaction mode changed");
	});

	it("appends committed mode once and does not accept a user tag as a mode event", () => {
		const mode = { role: "system" as const, runtimeEventId: "mode-on", runtimeMode: "terminal",
			content: [{ type: "text" as const, text: "<terminal-model-on>" }], timestamp: 1 };
		const { repository } = createRepository([projection(1, mode)]);
		const { service } = createService(repository);
		const context = { systemPrompt: "snapshot", messages: [createChatUserMessage("<terminal-model-on>", [], 2)], tools: [] };
		const synchronized = service.synchronizeRuntimeMode("session-1", context, "terminal");
		expect(synchronized.messages).toEqual([...context.messages, mode]);
		expect(service.synchronizeRuntimeMode("session-1", synchronized, "terminal")).toBe(synchronized);
		expect(synchronized.systemPrompt).toBe(context.systemPrompt);
	});

	it("retains and logs the original summary exception for manual requests", async () => {
		const message = createChatUserMessage("history".repeat(1000), [], 1);
		const response = fauxAssistantMessage("recent".repeat(300), { timestamp: 2 });
		const { repository } = createRepository([projection(1, message), projection(2, response)]);
		const cause = new Error("provider diagnostic");
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { service, model } = createService(repository, {
			compact: async () => {
				throw cause;
			},
		});
		await expect(
			service.compactContext({
				sessionId: "session-1",
				run: null,
				context: { systemPrompt: "", messages: [message, response], tools: [] },
				sessionModel: model,
				settings: { triggerPercent: 80, model: null, revision: 1, updatedAt: 1 },
				reason: "manual",
				force: true,
			}),
		).rejects.toMatchObject({ cause });
		expect(log).toHaveBeenCalledWith(
			"SSH Agent failure",
			expect.objectContaining({
				error: expect.objectContaining({
					cause: expect.objectContaining({
						message: "provider diagnostic",
						stack: expect.stringContaining("chat-context-service.test.ts:"),
					}),
				}),
			}),
		);
		log.mockRestore();
	});
	it("does not report nothing to compact when valid usage is excessive but no cut is possible", async () => {
		const response = fauxAssistantMessage("done", { timestamp: 1 });
		response.usage = { ...response.usage, input: 364_694, totalTokens: 364_694 };
		const { repository } = createRepository([projection(1, response)]);
		const compactMessages = vi.fn<typeof compact>();
		const { service, model } = createService(repository, { compact: compactMessages, contextWindow: 1_000_000 });
		await expect(
			service.compactContext({
				sessionId: "session-1",
				run: null,
				context: { systemPrompt: "", messages: [response], tools: [] },
				sessionModel: model,
				settings: { triggerPercent: 80, model: null, revision: 1, updatedAt: 1 },
				reason: "manual",
				force: true,
			}),
		).rejects.toMatchObject({ code: "chat_context_no_compactable_history" });
		expect(compactMessages).not.toHaveBeenCalled();
	});
	it.each(["valid", "error", "stale", "missing"] as const)(
		"uses only applicable provider usage to correct the manual cut budget (%s)",
		async (usageKind) => {
			const messages = Array.from({ length: 10 }, (_, index) =>
				projection(index + 1, createChatUserMessage("x".repeat(80_000), [], index + 1)),
			);
			const response = fauxAssistantMessage("done", { timestamp: usageKind === "stale" ? 0 : 11 });
			response.usage = { ...response.usage, input: 300, cacheRead: 364_032, output: 362, totalTokens: 364_694 };
			if (usageKind === "error") response.stopReason = "error";
			if (usageKind !== "missing") messages.push(projection(11, response));
			const { repository } = createRepository(messages);
			const compactMessages = vi.fn<typeof compact>(async (preparation) => ({
				ok: true,
				value: {
					summary: "summary",
					tokensBefore: preparation.tokensBefore,
					retainedTail: preparation.retainedTail,
				},
			}));
			const { service, model } = createService(repository, { compact: compactMessages, contextWindow: 1_000_000 });
			const outcome = await service.compactContext({
				sessionId: "session-1",
				run: null,
				context: { systemPrompt: "", messages: messages.map((entry) => entry.message), tools: [] },
				sessionModel: model,
				settings: { triggerPercent: 80, model: null, revision: 1, updatedAt: 1 },
				reason: "manual",
				force: true,
			});
			if (usageKind === "valid") {
				expect(outcome.status).toBe("completed");
				expect(outcome.tokensBefore).toBe(364_694);
				expect(compactMessages).toHaveBeenCalledOnce();
				expect(compactMessages.mock.calls[0]![0].messagesToSummarize.length).toBeGreaterThan(0);
				expect(compactMessages.mock.calls[0]![0].settings.keepRecentTokens).toBeLessThan(200_001);
			} else {
				expect(outcome.status).toBe("nothing_to_compact");
				expect(compactMessages).not.toHaveBeenCalled();
			}
		},
	);
	it("reports calibrated usage without mutating context or capping overflow", () => {
		const { repository } = createRepository([]);
		const { service, model } = createService(repository);
		const context = {
			systemPrompt: "system",
			messages: [createChatUserMessage("x".repeat(8_000), [], 1)],
			tools: [],
		};
		const original = structuredClone(context);
		const before = service.recordProviderRequest("run-1", model, context);
		const response = fauxAssistantMessage("done");
		response.usage = { ...response.usage, input: before.raw * 2 };
		service.recordProviderResponse("run-1", response);
		const usage = service.usage(model, context);
		expect(usage.contextTokens).toBe(service.estimate(model, context).corrected);
		expect(usage.usagePercent).toBe(Math.round((usage.contextTokens / model.contextWindow) * 10_000) / 100);
		expect(usage.usagePercent).toBeGreaterThan(100);
		expect(usage.source).toBe("estimated");
		expect(service.usage(model, context)).toEqual(usage);
		expect(context).toEqual(original);
		expect(repository.appendCompaction).not.toHaveBeenCalled();
	});
	it("loads original messages when no compaction exists", () => {
		const messages = [projection(1, { role: "user", content: "hello", timestamp: 1 })];
		const { repository } = createRepository(messages);
		const { service } = createService(repository);

		expect(service.load("session-1")).toEqual([messages[0]!.message]);
		expect(repository.listMessages).toHaveBeenCalledWith("session-1");
	});

	it("loads the latest compact message, retained tail, and later messages", () => {
		const retained = fauxAssistantMessage("retained", { timestamp: 2 });
		const compactMessage: StoredChatCompactionMessage = {
			role: "compactionSummary",
			summary: "summary",
			retainedTail: [retained],
			tokensBefore: 2_000,
			reason: "threshold",
			attempt: 1,
			provider: "provider",
			model: "model",
			timestamp: 3,
		};
		const messages = [
			projection(1, { role: "user", content: "old", timestamp: 1 }),
			projection(2, compactMessage),
			projection(3, { role: "user", content: "later", timestamp: 4 }),
		];
		const { repository } = createRepository(messages);
		const { service } = createService(repository);

		expect(service.load("session-1")).toEqual([compactMessage, retained, messages[2]!.message]);
		expect(repository.listMessages).toHaveBeenCalledWith("session-1", 2);
	});

	it("compacts before a provider request and persists the summary as a normal message", async () => {
		const longText = "x".repeat(8_000);
		const messages: ChatMessageProjection[] = [];
		for (let index = 0; index < 6; index += 1) {
			messages.push(projection(index * 2 + 1, { role: "user", content: longText, timestamp: index * 2 + 1 }));
			messages.push(projection(index * 2 + 2, fauxAssistantMessage(longText, { timestamp: index * 2 + 2 })));
		}
		const { repository, compactions } = createRepository(messages);
		const events = { publish: vi.fn() } satisfies ChatEventPublisher;
		const compactMessages = vi.fn<typeof compact>(async () => ({
			ok: true,
			value: {
				summary: "compact summary",
				tokensBefore: 24_000,
				retainedTail: [],
				details: { source: "test" },
			},
		}));
		const { service, model } = createService(repository, {
			compact: compactMessages,
			events,
			provider: "opencode-go",
		});

		const outcome = await service.compactContext({
			sessionId: "session-1",
			run,
			context: { systemPrompt: "system", messages: messages.map((message) => message.message), tools: [] },
			sessionModel: model,
			settings: { triggerPercent: 80, model: null, revision: 1, updatedAt: 1 },
			reason: "threshold",
			force: false,
		});

		expect(outcome.status).toBe("completed");
		expect(compactMessages).toHaveBeenCalledOnce();
		expect(compactMessages.mock.calls[0]?.[2]).toMatchObject({
			provider: "opencode-go",
			headers: {
				"x-opencode-session": "session-1",
				"x-opencode-client": "pi",
			},
		});
		expect(compactions).toEqual([
			expect.objectContaining({
				summary: "compact summary",
				reason: "threshold",
				attempt: 1,
			}),
		]);
		expect(outcome.context.messages[0]?.role).toBe("compactionSummary");
		expect(events.publish.mock.calls.map((call) => call[1])).toEqual([
			"compaction.started",
			"compaction.completed",
			"context.updated",
		]);
		expect(events.publish).toHaveBeenLastCalledWith(
			"run-1",
			"context.updated",
			service.usage(model, outcome.context),
		);
		expect(events.publish).toHaveBeenCalledWith(
			"run-1",
			"compaction.started",
			expect.objectContaining({ reason: "threshold", attempt: 1 }),
		);
		expect(events.publish).toHaveBeenCalledWith(
			"run-1",
			"compaction.completed",
			expect.objectContaining({ messageId: "compaction-1", reductionPercent: expect.any(Number) }),
		);
	});

	it("calibrates estimates with input and cache tokens while keeping the factor conservative", () => {
		const { repository } = createRepository([]);
		const { service, model } = createService(repository);
		const context = {
			systemPrompt: "system",
			messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
			tools: [],
		};
		const before = service.recordProviderRequest("run-1", model, context);
		const response = fauxAssistantMessage("done");
		response.usage = {
			input: before.raw,
			output: 1,
			cacheRead: before.raw,
			cacheWrite: before.raw,
			totalTokens: before.raw * 3 + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		service.recordProviderResponse("run-1", response);

		expect(service.estimate(model, context).factor).toBeCloseTo(1.4);
		expect(service.estimate(model, context).corrected).toBe(Math.ceil(before.raw * 1.4));
	});

	it("counts image placeholders while restoring retained attachment references before persistence", async () => {
		const attachmentMessage = createChatUserMessage("inspect", ["attachment-1"], 2);
		const projectedMessage = {
			...attachmentMessage,
			content: [
				{ type: "text" as const, text: "inspect" },
				{ type: "text" as const, text: "[Image attachment: screen.png]" },
				{ type: "image" as const, data: "", mimeType: "image/png" as const },
			],
		};
		const attachments = {
			compactionProjection: vi.fn((message: AgentMessage) =>
				message === attachmentMessage ? projectedMessage : message,
			),
			restoreCompactionMessage: vi.fn((message: AgentMessage) =>
				message === projectedMessage ? attachmentMessage : message,
			),
		};
		const messages = [
			projection(1, { role: "user", content: "old context".repeat(4_000), timestamp: 1 }),
			projection(2, fauxAssistantMessage("old response".repeat(4_000), { timestamp: 2 })),
			{
				...projection(3, attachmentMessage),
				attachments: [
					{
						id: "attachment-1",
						sessionId: "session-1",
						name: "screen.png",
						mimeType: "image/png",
						size: 100,
						storagePath: "attachments/sessions/session-1/screen.png",
						createdAt: 1,
					},
				],
			},
		];
		const { repository, compactions } = createRepository(messages);
		const compactMessages = vi.fn<typeof compact>(async () => ({
			ok: true,
			value: {
				summary: "old image summarized",
				tokensBefore: 2_000,
				retainedTail: [projectedMessage],
			},
		}));
		const { service, model } = createService(repository, {
			attachments,
			compact: compactMessages,
			contextWindow: 10_000,
		});

		const withoutImage = service.estimate(model, {
			systemPrompt: "",
			messages: [{ role: "user", content: "inspect", timestamp: 2 }],
			tools: [],
		});
		const withImage = service.estimate(model, { systemPrompt: "", messages: [attachmentMessage], tools: [] });
		expect(withImage.raw - withoutImage.raw).toBeGreaterThanOrEqual(1_200);

		await service.compactContext({
			sessionId: "session-1",
			run,
			context: { systemPrompt: "", messages: messages.map((message) => message.message), tools: [] },
			sessionModel: model,
			settings: { triggerPercent: 80, model: null, revision: 1, updatedAt: 1 },
			reason: "manual",
			force: true,
		});

		expect(compactions[0]?.retainedTail).toEqual([attachmentMessage]);
		expect(JSON.stringify(compactions[0])).not.toContain('"type":"image"');
		expect(attachments.restoreCompactionMessage).toHaveBeenCalledWith(projectedMessage);
	});

	it("runs a stronger second compaction only after the first reduces context by at least thirty percent", async () => {
		const longText = "x".repeat(8_000);
		const messages: ChatMessageProjection[] = [];
		for (let index = 0; index < 8; index += 1) {
			messages.push(projection(index * 2 + 1, { role: "user", content: longText, timestamp: index * 2 + 1 }));
			messages.push(projection(index * 2 + 2, fauxAssistantMessage(longText, { timestamp: index * 2 + 2 })));
		}
		const firstRetainedTail: AgentMessage[] = [];
		for (let index = 0; index < 4; index += 1) {
			firstRetainedTail.push({ role: "user", content: "u".repeat(2_000), timestamp: 100 + index * 2 });
			firstRetainedTail.push(fauxAssistantMessage("a".repeat(2_000), { timestamp: 101 + index * 2 }));
		}
		const { repository, compactions } = createRepository(messages);
		let call = 0;
		const compactMessages = vi.fn<typeof compact>(async (preparation) => {
			call += 1;
			return {
				ok: true,
				value: {
					summary: `summary ${call}`,
					tokensBefore: preparation.tokensBefore,
					retainedTail: call === 1 ? firstRetainedTail : [],
				},
			};
		});
		const events = { publish: vi.fn() };
		const { service, model } = createService(repository, { compact: compactMessages, events });

		const outcome = await service.compactContext({
			sessionId: "session-1",
			run,
			context: { systemPrompt: "system", messages: messages.map((message) => message.message), tools: [] },
			sessionModel: model,
			settings: { triggerPercent: 80, model: null, revision: 1, updatedAt: 1 },
			reason: "threshold",
			force: false,
		});

		expect(outcome).toMatchObject({ status: "completed", attempts: 2 });
		expect(compactMessages).toHaveBeenCalledTimes(2);
		expect(compactions.map((message) => message.attempt)).toEqual([1, 2]);
		expect(events.publish.mock.calls.map((call) => call[1])).toEqual([
			"compaction.started",
			"compaction.completed",
			"context.updated",
			"compaction.started",
			"compaction.completed",
			"context.updated",
		]);
	});
});
