import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { failureIdentity, reportFailure } from "../../application/failure-reporter.ts";
import type { ChatRepository, StoredChatCompaction } from "../../application/repositories/chat-repository.ts";
import type { Attachment } from "../../domain/attachment.ts";
import type {
	ChatMessageProjection,
	ChatModelSelection,
	ChatQueueBehavior,
	ChatQueueItem,
	ChatQueueItemStatus,
	ChatRun,
	ToolApproval,
} from "../../domain/chat.ts";
import { attachmentIdsFromMessage } from "../../domain/chat-attachment.ts";
import type { StoredChatCompactionMessage } from "../../domain/context-compaction.ts";
import type { BackendMessageKey, BackendMessageValues } from "../../i18n/message.ts";

export class SqliteChatRepository implements ChatRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	recoverInterrupted(now: number): void {
		this.database
			.prepare(
				"UPDATE chat_runs SET status = 'failed', failure_json = ?, finished_at = ?, updated_at = ? WHERE status IN ('pending', 'running')",
			)
			.run(
				JSON.stringify({
					code: "chat_run_interrupted",
					message: "Chat Run was interrupted by server restart",
					messageKey: "chat.run_interrupted",
					retryable: true,
				}),
				now,
				now,
			);
		this.database
			.prepare(
				"UPDATE chat_tool_approvals SET status = 'rejected', rejection_reason = 'server_restarted', resolved_at = ? WHERE status = 'pending'",
			)
			.run(now);
		this.database
			.prepare("UPDATE chat_queue_items SET status = 'cancelled', resolved_at = ? WHERE status = 'pending'")
			.run(now);
	}

	findRunByRequest(sessionId: string, requestId: string): ChatRun | undefined {
		return runFromRow(
			this.database
				.prepare("SELECT * FROM chat_runs WHERE session_id = ? AND request_id = ?")
				.get(sessionId, requestId),
		);
	}

	findRun(runId: string, sessionId: string): ChatRun | undefined {
		return runFromRow(
			this.database.prepare("SELECT * FROM chat_runs WHERE id = ? AND session_id = ?").get(runId, sessionId),
		);
	}

	findLatestModelSelection(sessionId: string): ChatModelSelection | undefined {
		const row = this.database
			.prepare(
				"SELECT provider_id, model_id, thinking_level FROM chat_runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get(sessionId);
		if (!row) return undefined;
		return {
			providerId: String(row.provider_id),
			modelId: String(row.model_id),
			thinkingLevel: String(row.thinking_level) as ThinkingLevel,
		};
	}

	findLatestRun(sessionId: string): ChatRun | undefined {
		return runFromRow(
			this.database
				.prepare("SELECT * FROM chat_runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
				.get(sessionId),
		);
	}

	hasActiveProvider(providerId: string): boolean {
		return (
			this.database
				.prepare("SELECT 1 FROM chat_runs WHERE provider_id = ? AND status IN ('pending', 'running') LIMIT 1")
				.get(providerId) !== undefined
		);
	}

	insertRun(run: ChatRun): void {
		this.database
			.prepare(
				"INSERT INTO chat_runs (id, session_id, workspace_id, request_id, provider_id, model_id, thinking_level, server_interaction_mode, terminal_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				run.id,
				run.sessionId,
				run.workspaceId,
				run.requestId,
				run.providerId,
				run.modelId,
				run.thinkingLevel,
				run.serverInteractionMode,
				run.terminalSessionId,
				run.status,
				run.createdAt,
				run.updatedAt,
			);
	}

	updateRun(run: ChatRun): void {
		const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
		if (terminal) this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = this.database
				.prepare(
					"UPDATE chat_runs SET status = ?, failure_json = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ? AND session_id = ? AND status IN ('pending', 'running')",
				)
				.run(
					run.status,
					run.failure ? JSON.stringify(run.failure) : null,
					run.startedAt ?? null,
					run.finishedAt ?? null,
					run.updatedAt,
					run.id,
					run.sessionId,
				);
			if (result.changes !== 1) {
				const current = this.findRun(run.id, run.sessionId);
				if (
					!terminal ||
					current?.status !== run.status ||
					JSON.stringify(current.failure) !== JSON.stringify(run.failure)
				) {
					throw new Error("Chat Run status changed before commit");
				}
			}
			if (terminal) {
				this.database
					.prepare(
						"UPDATE chat_tool_approvals SET status = 'rejected', rejection_reason = 'run_cancelled', resolved_at = ? WHERE run_id = ? AND status = 'pending'",
					)
					.run(run.updatedAt, run.id);
				this.database
					.prepare(
						"UPDATE chat_queue_items SET status = 'cancelled', resolved_at = ? WHERE run_id = ? AND status = 'pending'",
					)
					.run(run.updatedAt, run.id);
				this.database.exec("COMMIT");
			}
		} catch (error) {
			if (terminal) {
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					reportFailure(rollbackError, {
						stage: "rollback",
						runId: run.id,
						sessionId: run.sessionId,
						rootErrorId: failureIdentity(error).errorId,
					});
				}
			}
			throw error;
		}
	}

	findQueueItemByRequest(
		sessionId: string,
		requestId: string,
	): { id: string; status: ChatQueueItemStatus } | undefined {
		const row = this.database
			.prepare("SELECT id, status FROM chat_queue_items WHERE session_id = ? AND request_id = ?")
			.get(sessionId, requestId);
		if (!row) return undefined;
		return { id: String(row.id), status: String(row.status) as ChatQueueItemStatus };
	}

	insertQueueItem(item: ChatQueueItem): void {
		this.database
			.prepare(
				"INSERT INTO chat_queue_items (id, session_id, run_id, request_id, behavior, message_json, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				item.id,
				item.sessionId,
				item.runId,
				item.requestId,
				item.behavior,
				JSON.stringify(item.message),
				item.status,
				item.createdAt,
				item.resolvedAt ?? null,
			);
	}

	promoteQueueItem(sessionId: string, runId: string, itemId: string): boolean {
		return (
			this.database
				.prepare(
					"UPDATE chat_queue_items SET behavior = 'steer' WHERE id = ? AND session_id = ? AND run_id = ? AND status = 'pending' AND behavior = 'follow_up'",
				)
				.run(itemId, sessionId, runId).changes === 1
		);
	}

	findPendingQueueBehavior(sessionId: string, runId: string, itemId: string): ChatQueueBehavior | undefined {
		const row = this.database
			.prepare(
				"SELECT behavior FROM chat_queue_items WHERE id = ? AND session_id = ? AND run_id = ? AND status = 'pending'",
			)
			.get(itemId, sessionId, runId);
		return row ? (String(row.behavior) as ChatQueueBehavior) : undefined;
	}

	cancelQueueItem(sessionId: string, runId: string, itemId: string, resolvedAt: number): boolean {
		return (
			this.database
				.prepare(
					"UPDATE chat_queue_items SET status = 'cancelled', resolved_at = ? WHERE id = ? AND session_id = ? AND run_id = ? AND status = 'pending'",
				)
				.run(resolvedAt, itemId, sessionId, runId).changes === 1
		);
	}

	listPendingQueueMessages(sessionId: string, runId: string, behavior: ChatQueueBehavior): AgentMessage[] {
		return this.database
			.prepare(
				"SELECT message_json FROM chat_queue_items WHERE session_id = ? AND run_id = ? AND behavior = ? AND status = 'pending' ORDER BY created_at, id",
			)
			.all(sessionId, runId, behavior)
			.map((row) => JSON.parse(String(row.message_json)) as AgentMessage);
	}

	cancelPendingQueueByBehavior(
		sessionId: string,
		runId: string,
		behavior: ChatQueueBehavior,
		resolvedAt: number,
	): string[] {
		return this.database
			.prepare(
				"UPDATE chat_queue_items SET status = 'cancelled', resolved_at = ? WHERE session_id = ? AND run_id = ? AND behavior = ? AND status = 'pending' RETURNING id",
			)
			.all(resolvedAt, sessionId, runId, behavior)
			.map((row) => String(row.id));
	}

	cancelPendingQueue(sessionId: string, runId: string, resolvedAt: number): string[] {
		const ids = this.database
			.prepare(
				"SELECT id FROM chat_queue_items WHERE session_id = ? AND run_id = ? AND status = 'pending' ORDER BY created_at, id",
			)
			.all(sessionId, runId)
			.map((row) => String(row.id));
		this.database
			.prepare(
				"UPDATE chat_queue_items SET status = 'cancelled', resolved_at = ? WHERE session_id = ? AND run_id = ? AND status = 'pending'",
			)
			.run(resolvedAt, sessionId, runId);
		return ids;
	}

	consumePendingQueueMessage(
		sessionId: string,
		runId: string,
		message: AgentMessage,
		resolvedAt: number,
	): string | undefined {
		const row = this.database
			.prepare(
				"SELECT id FROM chat_queue_items WHERE session_id = ? AND run_id = ? AND status = 'pending' AND message_json = ? ORDER BY created_at, id LIMIT 1",
			)
			.get(sessionId, runId, JSON.stringify(message));
		if (!row) return undefined;
		const id = String(row.id);
		this.database
			.prepare("UPDATE chat_queue_items SET status = 'consumed', resolved_at = ? WHERE id = ?")
			.run(resolvedAt, id);
		return id;
	}

	listQueue(sessionId: string, runId: string, status: ChatQueueItemStatus): ChatQueueItem[] {
		return this.database
			.prepare(
				"SELECT * FROM chat_queue_items WHERE session_id = ? AND run_id = ? AND status = ? ORDER BY created_at, id",
			)
			.all(sessionId, runId, status)
			.map(queueItemFromRow);
	}

	appendMessage(id: string, sessionId: string, runId: string, message: AgentMessage, createdAt: number): void {
		this.insertMessage(id, sessionId, runId, messageType(message), message, createdAt);
	}

	appendCompaction(
		id: string,
		sessionId: string,
		runId: string | null,
		message: StoredChatCompactionMessage,
		createdAt: number,
	): ChatMessageProjection {
		const sequence = this.insertMessage(id, sessionId, runId, "compact", message, createdAt);
		return {
			id,
			sequence,
			...(runId === null ? {} : { runId }),
			message,
			createdAt,
		};
	}

	listMessages(sessionId: string, afterSequence = 0, limit = 10_000): ChatMessageProjection[] {
		const rows = this.database
			.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
			.all(sessionId, afterSequence, limit);
		return this.messagesFromRows(rows);
	}

	listMessagesBefore(sessionId: string, beforeSequence: number | undefined, limit: number): ChatMessageProjection[] {
		const rows =
			beforeSequence === undefined
				? this.database
						.prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY sequence DESC LIMIT ?")
						.all(sessionId, limit)
				: this.database
						.prepare(
							"SELECT * FROM chat_messages WHERE session_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?",
						)
						.all(sessionId, beforeSequence, limit);
		return this.messagesFromRows(rows.reverse());
	}

	insertApproval(approval: ToolApproval): void {
		this.database
			.prepare(
				"INSERT INTO chat_tool_approvals (id, session_id, run_id, assistant_message_id, tool_call_id, tool_name, description, description_message_key, description_values_json, status, source, rejection_reason, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				approval.id,
				approval.sessionId,
				approval.runId,
				approval.assistantMessageId,
				approval.toolCallId,
				approval.toolName,
				approval.description,
				approval.descriptionMessageKey ?? null,
				approval.descriptionValues === undefined ? null : JSON.stringify(approval.descriptionValues),
				approval.status,
				approval.source ?? null,
				approval.rejectionReason ?? null,
				approval.createdAt,
				approval.resolvedAt ?? null,
			);
	}

	findApproval(sessionId: string, approvalId: string): ToolApproval | undefined {
		return approvalFromRow(
			this.database
				.prepare("SELECT * FROM chat_tool_approvals WHERE id = ? AND session_id = ?")
				.get(approvalId, sessionId),
		);
	}

	listApprovals(sessionId: string, status: string): ToolApproval[] {
		return this.database
			.prepare("SELECT * FROM chat_tool_approvals WHERE session_id = ? AND status = ? ORDER BY created_at")
			.all(sessionId, status)
			.map((row) => requireApproval(row));
	}

	resolveApproval(approvalId: string, approved: boolean, resolvedAt: number): ToolApproval {
		this.database
			.prepare(
				"UPDATE chat_tool_approvals SET status = ?, source = 'user', rejection_reason = ?, resolved_at = ? WHERE id = ?",
			)
			.run(approved ? "approved" : "rejected", approved ? null : "user_rejected", resolvedAt, approvalId);
		return requireApproval(this.database.prepare("SELECT * FROM chat_tool_approvals WHERE id = ?").get(approvalId));
	}

	rejectPendingApproval(
		approvalId: string,
		reason: NonNullable<ToolApproval["rejectionReason"]>,
		resolvedAt: number,
	): ToolApproval | undefined {
		const result = this.database
			.prepare(
				"UPDATE chat_tool_approvals SET status = 'rejected', rejection_reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
			)
			.run(reason, resolvedAt, approvalId);
		return result.changes === 1
			? approvalFromRow(this.database.prepare("SELECT * FROM chat_tool_approvals WHERE id = ?").get(approvalId))
			: undefined;
	}

	latestCompaction(sessionId: string): StoredChatCompaction | undefined {
		const row = this.database
			.prepare(
				"SELECT id, sequence, run_id, message_json, created_at FROM chat_messages WHERE session_id = ? AND message_type = 'compact' ORDER BY sequence DESC LIMIT 1",
			)
			.get(sessionId);
		if (!row) return undefined;
		const value = row as Record<string, unknown>;
		return {
			id: String(value.id),
			sequence: Number(value.sequence),
			...(value.run_id === null ? {} : { runId: String(value.run_id) }),
			message: JSON.parse(String(value.message_json)) as StoredChatCompactionMessage,
			createdAt: Number(value.created_at),
		};
	}

	private insertMessage(
		id: string,
		sessionId: string,
		runId: string | null,
		type: string,
		message: AgentMessage,
		createdAt: number,
	): number {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database
				.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM chat_messages WHERE session_id = ?")
				.get(sessionId);
			const sequence = Number(row?.sequence ?? 1);
			this.database
				.prepare(
					"INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, provider, usage_json, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					sessionId,
					runId,
					sequence,
					type,
					providerFor(message),
					usageFor(message),
					JSON.stringify(message),
					createdAt,
				);
			const insertAttachment = this.database.prepare(
				"INSERT INTO chat_message_attachments (message_id, attachment_id, ordinal) SELECT ?, id, ? FROM attachments WHERE id = ? AND session_id = ?",
			);
			for (const [ordinal, attachmentId] of attachmentIdsFromMessage(message).entries()) {
				if (insertAttachment.run(id, ordinal, attachmentId, sessionId).changes !== 1) {
					throw new Error("Chat message references an Attachment outside its Session");
				}
			}
			this.database.exec("COMMIT");
			return sequence;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollbackError) {
				reportFailure(rollbackError, {
					stage: "rollback",
					runId: runId ?? undefined,
					sessionId,
					rootErrorId: failureIdentity(error).errorId,
				});
			}
			throw error;
		}
	}

	private messagesFromRows(rows: readonly object[]): ChatMessageProjection[] {
		if (rows.length === 0) return [];
		const attachments = new Map<string, Attachment[]>();
		const ids = rows.map((row) => String((row as Record<string, unknown>).id));
		for (let offset = 0; offset < ids.length; offset += 500) {
			const chunk = ids.slice(offset, offset + 500);
			const placeholders = chunk.map(() => "?").join(", ");
			const related = this.database
				.prepare(
					`SELECT cma.message_id, a.id, a.session_id, a.name, a.mime_type, a.size, a.storage_path, a.created_at
					 FROM chat_message_attachments cma
					 JOIN attachments a ON a.id = cma.attachment_id
					 WHERE cma.message_id IN (${placeholders})
					 ORDER BY cma.message_id, cma.ordinal`,
				)
				.all(...chunk);
			for (const row of related) {
				const value = row as Record<string, unknown>;
				const messageId = String(value.message_id);
				const list = attachments.get(messageId) ?? [];
				list.push(attachmentFromRow(value));
				attachments.set(messageId, list);
			}
		}
		return rows.map((row) => {
			const value = row as Record<string, unknown>;
			return messageFromRow(value, attachments.get(String(value.id)) ?? []);
		});
	}
}

function messageType(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "assistant":
		case "custom":
			return message.role;
		case "toolResult":
			return "tool";
		case "compactionSummary":
			return "compact";
		case "bashExecution":
			return "bash_execution";
		case "branchSummary":
			return "branch_summary";
	}
}

function providerFor(message: AgentMessage): string | null {
	if (message.role === "assistant") return message.provider;
	if (message.role === "compactionSummary" && "provider" in message) return String(message.provider);
	return null;
}

function usageFor(message: AgentMessage): string | null {
	if (message.role === "assistant") return JSON.stringify(message.usage);
	if (message.role === "compactionSummary" && "usage" in message && message.usage !== undefined) {
		return JSON.stringify(message.usage);
	}
	return null;
}

function runFromRow(row: unknown): ChatRun | undefined {
	if (!row) return undefined;
	const value = row as Record<string, unknown>;
	return {
		id: String(value.id),
		sessionId: String(value.session_id),
		workspaceId: String(value.workspace_id),
		requestId: String(value.request_id),
		providerId: String(value.provider_id),
		modelId: String(value.model_id),
		thinkingLevel: String(value.thinking_level) as ThinkingLevel,
		serverInteractionMode: value.server_interaction_mode === "terminal" ? "terminal" : "command",
		terminalSessionId: value.terminal_session_id === null ? null : String(value.terminal_session_id),
		status: String(value.status) as ChatRun["status"],
		...(value.failure_json === null ? {} : { failure: parseRunFailure(String(value.failure_json)) }),
		createdAt: Number(value.created_at),
		...(value.started_at === null ? {} : { startedAt: Number(value.started_at) }),
		...(value.finished_at === null ? {} : { finishedAt: Number(value.finished_at) }),
		updatedAt: Number(value.updated_at),
	};
}

function queueItemFromRow(row: unknown): ChatQueueItem {
	const value = row as Record<string, unknown>;
	return {
		id: String(value.id),
		sessionId: String(value.session_id),
		runId: String(value.run_id),
		requestId: String(value.request_id),
		behavior: String(value.behavior) as ChatQueueBehavior,
		message: JSON.parse(String(value.message_json)) as AgentMessage,
		status: String(value.status) as ChatQueueItemStatus,
		createdAt: Number(value.created_at),
		...(value.resolved_at === null ? {} : { resolvedAt: Number(value.resolved_at) }),
	};
}

function messageFromRow(value: Record<string, unknown>, attachments: Attachment[]): ChatMessageProjection {
	const parsed = JSON.parse(String(value.message_json)) as AgentMessage;
	const message = parsed.role === "user" ? withAuthoritativeAttachmentIds(parsed, attachments) : parsed;
	return {
		id: String(value.id),
		sequence: Number(value.sequence),
		...(value.run_id === null ? {} : { runId: String(value.run_id) }),
		message,
		...(attachments.length === 0 ? {} : { attachments }),
		createdAt: Number(value.created_at),
	};
}

function withAuthoritativeAttachmentIds(message: AgentMessage, attachments: readonly Attachment[]): AgentMessage {
	const result = { ...message } as AgentMessage & { attachmentIds?: string[] };
	delete result.attachmentIds;
	if (attachments.length > 0) result.attachmentIds = attachments.map((attachment) => attachment.id);
	return result;
}

function attachmentFromRow(value: Record<string, unknown>): Attachment {
	return {
		id: String(value.id),
		sessionId: String(value.session_id),
		name: String(value.name),
		mimeType: String(value.mime_type),
		size: Number(value.size),
		storagePath: String(value.storage_path),
		createdAt: Number(value.created_at),
	};
}

function approvalFromRow(row: unknown): ToolApproval | undefined {
	if (!row) return undefined;
	const value = row as Record<string, unknown>;
	return {
		id: String(value.id),
		sessionId: String(value.session_id),
		runId: String(value.run_id),
		assistantMessageId: String(value.assistant_message_id),
		toolCallId: String(value.tool_call_id),
		toolName: String(value.tool_name),
		description: String(value.description),
		...(value.description_message_key === null
			? {}
			: { descriptionMessageKey: String(value.description_message_key) as BackendMessageKey }),
		...(value.description_values_json === null
			? {}
			: { descriptionValues: JSON.parse(String(value.description_values_json)) as BackendMessageValues }),
		status: String(value.status) as ToolApproval["status"],
		...(value.source === null ? {} : { source: String(value.source) as ToolApproval["source"] }),
		...(value.rejection_reason === null
			? {}
			: { rejectionReason: String(value.rejection_reason) as ToolApproval["rejectionReason"] }),
		createdAt: Number(value.created_at),
		...(value.resolved_at === null ? {} : { resolvedAt: Number(value.resolved_at) }),
	};
}

function requireApproval(row: unknown): ToolApproval {
	const approval = approvalFromRow(row);
	if (!approval) throw new Error("Persisted Chat Approval was not found after update");
	return approval;
}

function parseRunFailure(json: string): NonNullable<ChatRun["failure"]> {
	const value: unknown = JSON.parse(json);
	if (
		value === null ||
		typeof value !== "object" ||
		!("code" in value) ||
		typeof value.code !== "string" ||
		!("message" in value) ||
		typeof value.message !== "string" ||
		!("retryable" in value) ||
		typeof value.retryable !== "boolean"
	)
		throw new Error("Invalid persisted Chat Run failure");
	if ("schemaVersion" in value && value.schemaVersion !== 1) throw new Error("Unsupported Chat Run failure version");
	if (
		"schemaVersion" in value &&
		(!("errorId" in value) ||
			typeof value.errorId !== "string" ||
			!("stage" in value) ||
			typeof value.stage !== "string")
	)
		throw new Error("Invalid persisted Chat Run failure identity");
	return value as NonNullable<ChatRun["failure"]>;
}
