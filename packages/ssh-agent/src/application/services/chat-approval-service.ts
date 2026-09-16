import type { ChatRun, ToolApproval } from "../../domain/chat.ts";
import { ChatError } from "../../domain/chat.ts";
import type { IdGenerator } from "../../domain/ids.ts";
import type { BackendMessageDescriptor } from "../../i18n/message.ts";
import type { ChatEventPublisher } from "../chat-run-event-hub.ts";
import { DEFAULT_CHAT_APPROVAL_TIMEOUT_MS } from "../chat-runtime-defaults.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";

export type ApprovalDecision =
	| { readonly approved: true; readonly source: "user" | "auto" }
	| { readonly approved: false; readonly reason: NonNullable<ToolApproval["rejectionReason"]> };

export interface ApprovalRequest {
	run: Pick<ChatRun, "id" | "sessionId">;
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	description: string;
	descriptionMessage?: BackendMessageDescriptor;
	autoApprove: boolean;
}

type ApprovalRepository = Pick<
	ChatRepository,
	"insertApproval" | "findApproval" | "listApprovals" | "resolveApproval" | "rejectPendingApproval"
>;

type PendingApproval = {
	runId: string;
	resolve(decision: ApprovalDecision, persistRejection?: boolean): void;
	reject(error: ChatError): void;
};

export class ChatApprovalService {
	readonly #repository: ApprovalRepository;
	readonly #ids: IdGenerator;
	readonly #events: ChatEventPublisher;
	readonly #approvalTimeoutMs: number;
	readonly #clock: () => number;
	readonly #pending = new Map<string, PendingApproval>();
	readonly #approvalIdsByRun = new Map<string, Set<string>>();

	constructor(options: {
		repository: ApprovalRepository;
		ids: IdGenerator;
		events: ChatEventPublisher;
		approvalTimeoutMs?: number;
		clock?: () => number;
	}) {
		this.#repository = options.repository;
		this.#ids = options.ids;
		this.#events = options.events;
		this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_CHAT_APPROVAL_TIMEOUT_MS;
		this.#clock = options.clock ?? Date.now;
	}

	request(input: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
		const now = this.#clock();
		const approval: ToolApproval = {
			id: this.#ids.next(),
			sessionId: input.run.sessionId,
			runId: input.run.id,
			assistantMessageId: input.assistantMessageId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			description: input.description,
			descriptionMessageKey: input.descriptionMessage?.key ?? "approval.tool_execution",
			...(input.descriptionMessage === undefined
				? { descriptionValues: { toolName: input.toolName } }
				: input.descriptionMessage.values === undefined
					? {}
					: { descriptionValues: input.descriptionMessage.values }),
			status: input.autoApprove ? "approved" : "pending",
			...(input.autoApprove ? { source: "auto" as const, resolvedAt: now } : {}),
			createdAt: now,
		};
		this.#repository.insertApproval(approval);
		this.#events.publish(input.run.id, input.autoApprove ? "approval.resolved" : "approval.requested", approval);
		if (input.autoApprove) return Promise.resolve({ approved: true, source: "auto" });
		return new Promise<ApprovalDecision>((resolve, reject) => {
			let settled = false;
			const onAbort = () => finish({ approved: false, reason: "run_cancelled" }, true);
			const finish = (decision: ApprovalDecision, persistRejection: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.#removePending(approval.id, input.run.id);
				try {
					if (!decision.approved && persistRejection) {
						const rejected = this.#repository.rejectPendingApproval(approval.id, decision.reason, this.#clock());
						if (rejected) this.#events.publish(input.run.id, "approval.resolved", rejected);
					}
					resolve(decision);
				} catch (error) {
					reject(
						new ChatError("chat_approval_persistence_failed", "Could not persist approval decision", 500, {
							cause: error,
						}),
					);
				}
			};
			const timer = setTimeout(() => finish({ approved: false, reason: "timeout" }, true), this.#approvalTimeoutMs);
			timer.unref();
			this.#pending.set(approval.id, {
				runId: input.run.id,
				reject: (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					this.#removePending(approval.id, input.run.id);
					reject(error);
				},
				resolve: (decision, persistRejection = false) => finish(decision, persistRejection),
			});
			const approvalIds = this.#approvalIdsByRun.get(input.run.id) ?? new Set<string>();
			approvalIds.add(approval.id);
			this.#approvalIdsByRun.set(input.run.id, approvalIds);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	resolve(sessionId: string, approvalId: string, approved: boolean): ToolApproval {
		const current = this.#repository.findApproval(sessionId, approvalId);
		if (!current) throw new ChatError("approval_not_found", "Tool Approval not found", 404);
		const desired = approved ? "approved" : "rejected";
		if (current.status !== "pending") {
			if (current.status === desired) return current;
			throw new ChatError("approval_already_resolved", "Tool Approval was already resolved", 409);
		}
		let resolved: ToolApproval;
		try {
			resolved = this.#repository.resolveApproval(approvalId, approved, this.#clock());
		} catch (cause) {
			const error = new ChatError("chat_approval_persistence_failed", "Could not persist approval decision", 500, {
				cause,
			});
			this.#pending.get(approvalId)?.reject(error);
			throw error;
		}
		this.#pending
			.get(approvalId)
			?.resolve(approved ? { approved: true, source: "user" } : { approved: false, reason: "user_rejected" });
		this.#events.publish(resolved.runId, "approval.resolved", resolved);
		return resolved;
	}

	list(sessionId: string, status = "pending"): ToolApproval[] {
		return this.#repository.listApprovals(sessionId, status);
	}

	cancelRun(runId: string, reason: "run_cancelled" | "server_restarted"): void {
		for (const approvalId of [...(this.#approvalIdsByRun.get(runId) ?? [])]) {
			this.#pending.get(approvalId)?.resolve({ approved: false, reason }, true);
		}
	}

	close(): void {
		for (const pending of [...this.#pending.values()]) {
			pending.resolve({ approved: false, reason: "run_cancelled" }, true);
		}
	}

	#removePending(approvalId: string, runId: string): void {
		this.#pending.delete(approvalId);
		const approvalIds = this.#approvalIdsByRun.get(runId);
		if (!approvalIds) return;
		approvalIds.delete(approvalId);
		if (approvalIds.size === 0) this.#approvalIdsByRun.delete(runId);
	}
}
