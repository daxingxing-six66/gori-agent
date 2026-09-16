import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ChatQueueBehavior, ChatQueueItem, ChatQueueItemStatus, ChatRun } from "../../domain/chat.ts";
import { ChatError } from "../../domain/chat.ts";
import { createChatUserMessage } from "../../domain/chat-attachment.ts";
import type { IdGenerator } from "../../domain/ids.ts";
import type { ChatEventPublisher } from "../chat-run-event-hub.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";
import type { ChatAttachmentService } from "./chat-attachment-service.ts";

export interface ChatQueueDriver {
	steer(message: AgentMessage): void;
	followUp(message: AgentMessage): void;
	clearSteeringQueue(): void;
	clearFollowUpQueue(): void;
}

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

export class ChatQueueService {
	readonly #repository: QueueRepository;
	readonly #ids: IdGenerator;
	readonly #events: ChatEventPublisher;
	readonly #attachments: Pick<ChatAttachmentService, "validateReferences">;
	readonly #clock: () => number;

	constructor(options: {
		repository: QueueRepository;
		ids: IdGenerator;
		events: ChatEventPublisher;
		attachments: Pick<ChatAttachmentService, "validateReferences">;
		clock?: () => number;
	}) {
		this.#repository = options.repository;
		this.#ids = options.ids;
		this.#events = options.events;
		this.#attachments = options.attachments;
		this.#clock = options.clock ?? Date.now;
	}

	async enqueue(
		run: ChatRun,
		driver: ChatQueueDriver,
		acceptSteering: boolean,
		model: Model<Api>,
		input: { requestId: string; behavior: ChatQueueBehavior; message: string; attachmentIds?: string[] },
	): Promise<{ id: string; status: ChatQueueItemStatus }> {
		const existing = this.#repository.findQueueItemByRequest(run.sessionId, input.requestId);
		if (existing) return existing;
		const message = input.message.trim();
		const attachmentIds = input.attachmentIds ?? [];
		if (!message && attachmentIds.length === 0)
			throw new ChatError("chat_message_invalid", "message must not be empty");
		await this.#attachments.validateReferences(run.sessionId, attachmentIds, model);
		const id = this.#ids.next();
		const createdAt = this.#clock();
		const userMessage = createChatUserMessage(message, attachmentIds, createdAt);
		this.#repository.insertQueueItem({
			id,
			sessionId: run.sessionId,
			runId: run.id,
			requestId: input.requestId,
			behavior: input.behavior,
			message: userMessage,
			status: "pending",
			createdAt,
		});
		if (input.behavior === "steer" && !acceptSteering) {
			this.#repository.cancelQueueItem(run.sessionId, run.id, id, createdAt);
			this.#events.publish(run.id, "queue.updated", {
				id,
				behavior: input.behavior,
				status: "cancelled",
				resolvedAt: createdAt,
			});
			return { id, status: "cancelled" };
		}
		try {
			if (input.behavior === "steer") driver.steer(userMessage);
			else driver.followUp(userMessage);
		} catch (error) {
			try {
				this.#repository.cancelQueueItem(run.sessionId, run.id, id, this.#clock());
			} catch (compensationError) {
				throw new ChatError("chat_persistence_failed", "Queue injection and compensation failed", 503, {
					cause: new AggregateError([error, compensationError], "Queue injection and compensation failed", {
						cause: error,
					}),
				});
			}
			throw error;
		}
		this.#events.publish(run.id, "queue.updated", {
			id,
			behavior: input.behavior,
			status: "pending",
			message,
			...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
		});
		return { id, status: "pending" };
	}

	promote(run: ChatRun, driver: ChatQueueDriver, itemId: string): ChatQueueItem {
		const item = this.#repository.listQueue(run.sessionId, run.id, "pending").find((entry) => entry.id === itemId);
		if (!item) throw new ChatError("chat_queue_item_not_found", "Pending queue item not found", 404);
		if (item.behavior === "steer") return item;
		// No await: the Run owner cannot consume messages between persistence and queue rebuilding.
		try {
			if (!this.#repository.promoteQueueItem(run.sessionId, run.id, itemId)) {
				throw new ChatError("chat_queue_item_not_found", "Pending queue item not found", 404);
			}
			const remaining = this.#repository.listPendingQueueMessages(run.sessionId, run.id, "follow_up");
			driver.clearFollowUpQueue();
			for (const message of remaining) driver.followUp(message);
			driver.steer(item.message);
		} catch (cause) {
			if (cause instanceof ChatError && cause.code === "chat_queue_item_not_found") throw cause;
			throw new ChatError("chat_persistence_failed", "Queue promotion could not synchronize the Agent", 503, {
				cause,
			});
		}
		const promoted = { ...item, behavior: "steer" as const };
		this.#events.publish(run.id, "queue.updated", {
			id: promoted.id,
			behavior: promoted.behavior,
			status: promoted.status,
		});
		return promoted;
	}

	cancel(run: ChatRun, driver: ChatQueueDriver, itemId: string): void {
		const behavior = this.#repository.findPendingQueueBehavior(run.sessionId, run.id, itemId);
		if (!behavior || !this.#repository.cancelQueueItem(run.sessionId, run.id, itemId, this.#clock())) {
			throw new ChatError("chat_queue_item_not_found", "Pending queue item not found", 404);
		}
		const remaining = this.#repository.listPendingQueueMessages(run.sessionId, run.id, behavior);
		if (behavior === "steer") driver.clearSteeringQueue();
		else driver.clearFollowUpQueue();
		for (const message of remaining) {
			if (behavior === "steer") driver.steer(message);
			else driver.followUp(message);
		}
		this.#events.publish(run.id, "queue.updated", { id: itemId, status: "cancelled" });
	}

	cancelRun(run: ChatRun): void {
		const resolvedAt = this.#clock();
		for (const id of this.#repository.cancelPendingQueue(run.sessionId, run.id, resolvedAt)) {
			this.#events.publish(run.id, "queue.updated", { id, status: "cancelled", resolvedAt });
		}
	}

	cancelSteeringAfterTurn(run: ChatRun, driver: ChatQueueDriver): void {
		driver.clearSteeringQueue();
		const resolvedAt = this.#clock();
		for (const id of this.#repository.cancelPendingQueueByBehavior(run.sessionId, run.id, "steer", resolvedAt)) {
			this.#events.publish(run.id, "queue.updated", {
				id,
				behavior: "steer",
				status: "cancelled",
				resolvedAt,
			});
		}
	}

	consume(run: ChatRun, message: AgentMessage): void {
		const id = this.#repository.consumePendingQueueMessage(run.sessionId, run.id, message, this.#clock());
		if (id) this.#events.publish(run.id, "queue.updated", { id, status: "consumed" });
	}

	list(run: ChatRun, status: ChatQueueItemStatus = "pending"): ChatQueueItem[] {
		return this.#repository.listQueue(run.sessionId, run.id, status);
	}
}
