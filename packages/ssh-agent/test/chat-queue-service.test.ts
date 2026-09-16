import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ChatEventPublisher } from "../src/application/chat-run-event-hub.ts";
import type { ChatRepository } from "../src/application/repositories/chat-repository.ts";
import { type ChatQueueDriver, ChatQueueService } from "../src/application/services/chat-queue-service.ts";
import type { ChatQueueBehavior, ChatQueueItem, ChatRun } from "../src/domain/chat.ts";

type QueueRepository = Pick<
	ChatRepository,
	| "findQueueItemByRequest"
	| "insertQueueItem"
	| "promoteQueueItem"
	| "findPendingQueueBehavior"
	| "cancelQueueItem"
	| "listPendingQueueMessages"
	| "cancelPendingQueueByBehavior"
	| "cancelPendingQueue"
	| "consumePendingQueueMessage"
	| "listQueue"
>;

const run: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "run-request",
	providerId: "provider",
	modelId: "model",
	thinkingLevel: "off",
	serverInteractionMode: "command",
	terminalSessionId: null,
	status: "running",
	createdAt: 1,
	updatedAt: 1,
};

const model = { input: ["text", "image"] } as Model<Api>;

function createContext() {
	const items: ChatQueueItem[] = [];
	const repository = {
		findQueueItemByRequest: vi.fn((sessionId: string, requestId: string) => {
			const item = items.find((candidate) => candidate.sessionId === sessionId && candidate.requestId === requestId);
			return item ? { id: item.id, status: item.status } : undefined;
		}),
		insertQueueItem: vi.fn((item: ChatQueueItem) => items.push({ ...item })),
		promoteQueueItem: vi.fn((sessionId: string, runId: string, itemId: string) => {
			const item = items.find(
				(entry) =>
					entry.sessionId === sessionId &&
					entry.runId === runId &&
					entry.id === itemId &&
					entry.status === "pending" &&
					entry.behavior === "follow_up",
			);
			if (!item) return false;
			item.behavior = "steer";
			return true;
		}),
		findPendingQueueBehavior: vi.fn(
			(sessionId: string, runId: string, itemId: string) =>
				items.find(
					(item) =>
						item.sessionId === sessionId &&
						item.runId === runId &&
						item.id === itemId &&
						item.status === "pending",
				)?.behavior,
		),
		cancelQueueItem: vi.fn((sessionId: string, runId: string, itemId: string, resolvedAt: number) => {
			const item = items.find(
				(candidate) =>
					candidate.sessionId === sessionId &&
					candidate.runId === runId &&
					candidate.id === itemId &&
					candidate.status === "pending",
			);
			if (!item) return false;
			item.status = "cancelled";
			item.resolvedAt = resolvedAt;
			return true;
		}),
		listPendingQueueMessages: vi.fn((sessionId: string, runId: string, behavior: ChatQueueBehavior) =>
			items
				.filter(
					(item) =>
						item.sessionId === sessionId &&
						item.runId === runId &&
						item.behavior === behavior &&
						item.status === "pending",
				)
				.map((item) => item.message),
		),
		cancelPendingQueueByBehavior: vi.fn(
			(sessionId: string, runId: string, behavior: ChatQueueBehavior, resolvedAt: number) =>
				cancelMatching(
					items,
					(item) => item.sessionId === sessionId && item.runId === runId && item.behavior === behavior,
					resolvedAt,
				),
		),
		cancelPendingQueue: vi.fn((sessionId: string, runId: string, resolvedAt: number) =>
			cancelMatching(items, (item) => item.sessionId === sessionId && item.runId === runId, resolvedAt),
		),
		consumePendingQueueMessage: vi.fn(
			(sessionId: string, runId: string, message: AgentMessage, resolvedAt: number) => {
				const item = items.find(
					(candidate) =>
						candidate.sessionId === sessionId &&
						candidate.runId === runId &&
						candidate.status === "pending" &&
						candidate.message === message,
				);
				if (!item) return undefined;
				item.status = "consumed";
				item.resolvedAt = resolvedAt;
				return item.id;
			},
		),
		listQueue: vi.fn((sessionId: string, runId: string, status: ChatQueueItem["status"]) =>
			items.filter((item) => item.sessionId === sessionId && item.runId === runId && item.status === status),
		),
	} satisfies QueueRepository;
	const driver = {
		steer: vi.fn(),
		followUp: vi.fn(),
		clearSteeringQueue: vi.fn(),
		clearFollowUpQueue: vi.fn(),
	} satisfies ChatQueueDriver;
	const events = { publish: vi.fn() } satisfies ChatEventPublisher;
	let sequence = 0;
	let now = 100;
	const attachments = { validateReferences: vi.fn(async () => []) };
	const service = new ChatQueueService({
		repository,
		ids: { next: () => `queue-${++sequence}` },
		events,
		attachments,
		clock: () => ++now,
	});
	return { service, repository, driver, events, attachments, items };
}

function cancelMatching(
	items: ChatQueueItem[],
	matches: (item: ChatQueueItem) => boolean,
	resolvedAt: number,
): string[] {
	const ids: string[] = [];
	for (const item of items) {
		if (item.status !== "pending" || !matches(item)) continue;
		item.status = "cancelled";
		item.resolvedAt = resolvedAt;
		ids.push(item.id);
	}
	return ids;
}

describe("ChatQueueService", () => {
	it("promotes the same item with attachments exactly once and preserves other follow-ups", async () => {
		const { service, driver, items, repository } = createContext();
		await service.enqueue(run, driver, true, model, {
			requestId: "one",
			behavior: "follow_up",
			message: "first",
			attachmentIds: ["image-1"],
		});
		await service.enqueue(run, driver, true, model, { requestId: "two", behavior: "follow_up", message: "second" });
		const original = { ...items[0]! };
		driver.followUp.mockClear();
		expect(service.promote(run, driver, original.id)).toEqual({ ...original, behavior: "steer" });
		service.promote(run, driver, original.id);
		expect(repository.insertQueueItem).toHaveBeenCalledTimes(2);
		expect(repository.promoteQueueItem).toHaveBeenCalledOnce();
		expect(driver.steer).toHaveBeenCalledExactlyOnceWith(original.message);
		expect(driver.followUp).toHaveBeenCalledExactlyOnceWith(items[1]!.message);
		expect(driver.clearSteeringQueue).not.toHaveBeenCalled();
	});

	it.each(["consumed", "cancelled"] as const)("rejects promotion of a %s item", async (status) => {
		const { service, driver, items } = createContext();
		await service.enqueue(run, driver, true, model, { requestId: "one", behavior: "follow_up", message: "first" });
		items[0]!.status = status;
		expect(() => service.promote(run, driver, items[0]!.id)).toThrow("Pending queue item not found");
		expect(driver.steer).not.toHaveBeenCalled();
	});

	it("persists and enqueues a steer item idempotently", async () => {
		const context = createContext();
		const input = { requestId: "request-1", behavior: "steer" as const, message: "  investigate  " };

		await expect(context.service.enqueue(run, context.driver, true, model, input)).resolves.toEqual({
			id: "queue-1",
			status: "pending",
		});
		await expect(context.service.enqueue(run, context.driver, true, model, input)).resolves.toEqual({
			id: "queue-1",
			status: "pending",
		});
		expect(context.repository.insertQueueItem).toHaveBeenCalledOnce();
		expect(context.driver.steer).toHaveBeenCalledOnce();
		expect(context.driver.steer).toHaveBeenCalledWith(
			expect.objectContaining({ role: "user", content: "investigate" }),
		);
	});

	it("does not inject when the conditional update loses and reports injection failures as fatal", async () => {
		const { service, repository, driver, events } = createContext();
		await service.enqueue(run, driver, true, model, { requestId: "one", behavior: "follow_up", message: "first" });
		repository.promoteQueueItem.mockReturnValueOnce(false);
		expect(() => service.promote(run, driver, "queue-1")).toThrow("Pending queue item not found");
		expect(driver.steer).not.toHaveBeenCalled();
		driver.steer.mockImplementationOnce(() => {
			throw new Error("injection failed");
		});
		events.publish.mockClear();
		expect(() => service.promote(run, driver, "queue-1")).toThrow(
			expect.objectContaining({ code: "chat_persistence_failed" }),
		);
		expect(events.publish).not.toHaveBeenCalled();
	});

	it("accepts an image-only follow-up and preserves Attachment order", async () => {
		const context = createContext();
		const input = {
			requestId: "image-1",
			behavior: "follow_up" as const,
			message: "",
			attachmentIds: ["image-2", "image-1"],
		};

		await expect(context.service.enqueue(run, context.driver, true, model, input)).resolves.toEqual({
			id: "queue-1",
			status: "pending",
		});
		expect(context.attachments.validateReferences).toHaveBeenCalledWith("session-1", ["image-2", "image-1"], model);
		expect(context.driver.followUp).toHaveBeenCalledWith({
			role: "user",
			content: "",
			attachmentIds: ["image-2", "image-1"],
			timestamp: 101,
		});
		expect(context.events.publish).toHaveBeenCalledWith(
			"run-1",
			"queue.updated",
			expect.objectContaining({ attachmentIds: ["image-2", "image-1"] }),
		);
	});

	it("cancels a new steer immediately when the Runtime rejects steering", async () => {
		const context = createContext();

		await expect(
			context.service.enqueue(run, context.driver, false, model, {
				requestId: "request-1",
				behavior: "steer",
				message: "stop",
			}),
		).resolves.toEqual({ id: "queue-1", status: "cancelled" });
		expect(context.driver.steer).not.toHaveBeenCalled();
		expect(context.items[0]).toMatchObject({ status: "cancelled" });
	});

	it("rebuilds only the affected Agent queue after single-item cancellation", async () => {
		const context = createContext();
		await context.service.enqueue(run, context.driver, true, model, {
			requestId: "request-1",
			behavior: "steer",
			message: "first",
		});
		await context.service.enqueue(run, context.driver, true, model, {
			requestId: "request-2",
			behavior: "steer",
			message: "second",
		});
		context.driver.steer.mockClear();

		context.service.cancel(run, context.driver, "queue-1");

		expect(context.driver.clearSteeringQueue).toHaveBeenCalledOnce();
		expect(context.driver.steer).toHaveBeenCalledOnce();
		expect(context.driver.steer).toHaveBeenCalledWith(expect.objectContaining({ content: "second" }));
	});

	it("cancels steer after rejection while preserving follow-up", async () => {
		const context = createContext();
		await context.service.enqueue(run, context.driver, true, model, {
			requestId: "steer",
			behavior: "steer",
			message: "steer",
		});
		await context.service.enqueue(run, context.driver, true, model, {
			requestId: "follow-up",
			behavior: "follow_up",
			message: "follow up",
		});

		context.service.cancelSteeringAfterTurn(run, context.driver);

		expect(context.service.list(run, "cancelled")).toHaveLength(1);
		expect(context.service.list(run, "pending")).toEqual([
			expect.objectContaining({ behavior: "follow_up", status: "pending" }),
		]);
	});

	it("consumes delivered messages and cancels every remaining item with the Run", async () => {
		const context = createContext();
		await context.service.enqueue(run, context.driver, true, model, {
			requestId: "request-1",
			behavior: "follow_up",
			message: "first",
		});
		await context.service.enqueue(run, context.driver, true, model, {
			requestId: "request-2",
			behavior: "follow_up",
			message: "second",
		});
		context.service.consume(run, context.items[0]!.message);
		context.service.cancelRun(run);

		expect(context.service.list(run, "consumed")).toHaveLength(1);
		expect(context.service.list(run, "cancelled")).toHaveLength(1);
		expect(context.events.publish).toHaveBeenCalledWith(
			"run-1",
			"queue.updated",
			expect.objectContaining({ id: "queue-1", status: "consumed" }),
		);
	});
});
