import { DIAGNOSE_LIMITS, DiagnoseError, diagnoseText, nextDiagnoseNode, parseDiagnoseUpdate, sealDiagnoseNode,
	type DiagnoseMutationResult, type DiagnoseNode, type DiagnoseNodePage, type DiagnoseRequestLink, type DiagnoseTask, type DiagnoseToolBinding } from "../../domain/diagnose.ts";
import type { Clock, IdGenerator } from "../../domain/ids.ts";
import type { ChatMessageProjection } from "../../domain/chat.ts";
import type { DiagnoseRepository } from "../repositories/diagnose-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { TransactionRunner } from "../transaction-runner.ts";
import type { WorkspaceEventHub } from "../workspace-event-hub.ts";
import type { SessionTaskModePolicy } from "./session-task-mode-policy.ts";

export class DiagnoseService {
	private readonly options: { repository: DiagnoseRepository; sessions: SessionRepository; transactions: TransactionRunner;
		events: WorkspaceEventHub; clock: Clock; ids: IdGenerator; modes: SessionTaskModePolicy };
	private readonly terminalListeners = new Set<(task: DiagnoseTask) => void>();
	constructor(options: DiagnoseService["options"]) { this.options = options; }
	onTerminal(listener: (task: DiagnoseTask) => void): () => void { this.terminalListeners.add(listener); return () => this.terminalListeners.delete(listener); }
	active(sessionId: string): DiagnoseTask | null { return this.options.repository.active(sessionId) ?? null; }
	get(sessionId: string, taskId: string): DiagnoseTask {
		const task = this.options.repository.find(sessionId, taskId);
		if (!task) throw new DiagnoseError("diagnose_not_found", "Diagnosis was not found", 404);
		return task;
	}
	byRequest(sessionId: string, requestId: string): DiagnoseTask | undefined { return this.options.repository.byRequest(sessionId, requestId); }
	async create(sessionId: string, requestId: string): Promise<DiagnoseTask> {
		diagnoseText(requestId, "requestId", 200);
		let created = false;
		let message: ChatMessageProjection | undefined;
		const task = await this.options.transactions.run(async () => {
			const session = await this.options.sessions.findById(sessionId);
			if (!session) throw new DiagnoseError("diagnose_session_not_found", "Session was not found", 404);
			const existing = this.byRequest(sessionId, requestId) ?? this.active(sessionId);
			if (existing) return existing;
			this.options.modes.assertCanStart(sessionId, "diagnose");
			const now = this.options.clock.now();
			const result: DiagnoseTask = { id: this.options.ids.next(), sessionId, workspaceId: session.workspaceId, requestId,
				title: "诊断任务", status: "active", revision: 1, currentSequence: 0, conclusionAvailable: false, createdAt: now, updatedAt: now };
			this.options.repository.insert(result);
			message = this.options.repository.historyMessage(sessionId, result.id);
			created = true;
			return result;
		});
		if (created) this.publish(task, undefined, true, message);
		return task;
	}
	current(sessionId: string, taskId: string): DiagnoseNode | undefined { this.get(sessionId, taskId); return this.options.repository.current(taskId); }
	nodes(sessionId: string, taskId: string, beforeSequence?: number, limit = 20): DiagnoseNodePage {
		this.get(sessionId, taskId);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)))
			throw new DiagnoseError("diagnose_request_invalid", "limit must be 1–50 and beforeSequence a positive integer", 400, "limit");
		const rows = this.options.repository.nodes(taskId, beforeSequence, limit + 1);
		let nodes = rows.length > limit ? rows.slice(1) : rows;
		// JSON escaping counts toward the output budget. Keep complete records, newest first selection, ascending display.
		while (nodes.length > 1 && new TextEncoder().encode(JSON.stringify({ nodes, nextBeforeSequence: nodes[0]!.sequence })).length > DIAGNOSE_LIMITS.inspectBytes)
			nodes = nodes.slice(1);
		return { nodes, nextBeforeSequence: rows.length > nodes.length ? nodes[0]?.sequence ?? null : null };
	}
	conclusion(sessionId: string, taskId: string): string {
		this.get(sessionId, taskId);
		const markdown = this.options.repository.conclusion(taskId);
		if (markdown === undefined) throw new DiagnoseError("diagnose_conclusion_not_ready", "No conclusion has been saved", 409);
		return markdown;
	}
	bindRun(sessionId: string, taskId: string, runId: string): void {
		this.requireActive(sessionId, taskId);
		this.options.repository.bindRun(taskId, runId);
	}
	boundTask(runId: string): string | undefined { return this.options.repository.boundTask(runId); }
	requestLink(taskId: string, requestId: string): DiagnoseRequestLink | undefined { return this.options.repository.requestLink(taskId, requestId); }
	async saveRequestLink(sessionId: string, taskId: string, link: DiagnoseRequestLink, conclusion: boolean): Promise<void> {
		let changed: DiagnoseTask | undefined;
		let message: ChatMessageProjection | undefined;
		await this.options.transactions.run(() => {
			if (this.options.repository.requestLink(taskId, link.requestId)) return;
			this.options.repository.saveRequestLink(taskId, link);
			const task = this.get(sessionId, taskId);
			if (conclusion && task.status === "active") {
				changed = { ...task, conclusionRequest: link, revision: task.revision + 1, updatedAt: this.now(task) };
				this.options.repository.update(changed, task.revision);
				message = this.options.repository.historyMessage(sessionId, taskId);
			}
		});
		if (changed) this.publish(changed, undefined, false, message);
	}
	async update(binding: DiagnoseToolBinding, value: unknown): Promise<DiagnoseMutationResult> {
		const input = parseDiagnoseUpdate(value);
		return this.mutate(binding, JSON.stringify({ tool: "update", input }), (task) => {
			const now = this.now(task);
			const current = this.options.repository.current(task.id);
			const node = input.node ? nextDiagnoseNode(task, current, input.node, now) : undefined;
			if (node) {
				if (input.node!.action === "append") this.options.repository.appendNode(node);
				else this.options.repository.updateCurrent(node, current!.revision);
			}
			const updated = { ...task, title: input.title ?? task.title, currentSequence: node?.sequence ?? task.currentSequence,
				revision: task.revision + 1, updatedAt: now };
			this.options.repository.update(updated, task.revision);
			return { task: updated, node };
		});
	}
	async finish(binding: DiagnoseToolBinding, markdown: unknown): Promise<DiagnoseMutationResult> {
		const conclusion = diagnoseText(markdown, "conclusionMarkdown", DIAGNOSE_LIMITS.conclusionBytes, true);
		return this.mutate(binding, JSON.stringify({ tool: "finish", conclusion }), (task) => this.end(task, "completed", conclusion));
	}
	async cancel(sessionId: string, taskId: string): Promise<DiagnoseTask> {
		let changed: { task: DiagnoseTask; node?: DiagnoseNode } | undefined;
		let message: ChatMessageProjection | undefined;
		const task = await this.options.transactions.run(() => {
			const current = this.get(sessionId, taskId);
			if (current.status !== "active") return current;
			changed = this.end(current, "cancelled");
			message = this.options.repository.historyMessage(sessionId, taskId);
			return changed.task;
		});
		if (changed) this.publish(changed.task, changed.node, false, message);
		return task;
	}
	private async mutate(binding: DiagnoseToolBinding, request: string, operation: (task: DiagnoseTask) => { task: DiagnoseTask; node?: DiagnoseNode }): Promise<DiagnoseMutationResult> {
		let changed: { task: DiagnoseTask; node?: DiagnoseNode } | undefined;
		let message: ChatMessageProjection | undefined;
		const result = await this.options.transactions.run(() => {
			this.get(binding.sessionId, binding.taskId);
			const receipt = this.options.repository.receipt(binding.taskId, binding.runId, binding.toolCallId);
			if (receipt) {
				if (receipt.request !== request) throw new DiagnoseError("diagnose_replay_conflict", "This tool call was already committed with different arguments", 409);
				return receipt.result;
			}
			const task = this.requireActive(binding.sessionId, binding.taskId);
			if (this.boundTask(binding.runId) !== task.id) throw new DiagnoseError("diagnose_run_mismatch", "This Run is not bound to this diagnosis", 409);
			changed = operation(task);
			const result: DiagnoseMutationResult = { taskId: task.id, status: changed.task.status, revision: changed.task.revision,
				conclusionAvailable: changed.task.conclusionAvailable, ...(changed.node ? { currentNode: changed.node } : {}) };
			this.options.repository.saveReceipt(task.id, binding.runId, binding.toolCallId, request, result);
			message = this.options.repository.historyMessage(task.sessionId, task.id);
			return result;
		});
		if (changed) this.publish(changed.task, changed.node, false, message);
		return result;
	}
	private end(task: DiagnoseTask, status: "completed" | "cancelled", conclusion?: string): { task: DiagnoseTask; node?: DiagnoseNode } {
		const now = this.now(task);
		const current = this.options.repository.current(task.id);
		const node = current ? sealDiagnoseNode(current, status === "cancelled", now) : undefined;
		if (node) this.options.repository.updateCurrent(node, current!.revision);
		const updated: DiagnoseTask = { ...task, status, revision: task.revision + 1, updatedAt: now, finishedAt: now, conclusionAvailable: conclusion !== undefined };
		this.options.repository.update(updated, task.revision, conclusion);
		return { task: updated, node };
	}
	private requireActive(sessionId: string, taskId: string): DiagnoseTask {
		const task = this.get(sessionId, taskId);
		if (task.status !== "active") throw new DiagnoseError("diagnose_inactive", "Diagnosis has ended", 409);
		return task;
	}
	private now(task: DiagnoseTask): number { return Math.max(this.options.clock.now(), task.updatedAt + 1); }
	private publish(task: DiagnoseTask, node?: DiagnoseNode, created = false, message?: ChatMessageProjection): void {
		this.options.events.publish(task.workspaceId, { type: "diagnose.task.updated", data: task });
		if (node) this.options.events.publish(task.workspaceId, { type: "diagnose.node.updated", data: { sessionId: task.sessionId, workspaceId: task.workspaceId, node } });
		if (message) this.options.events.publish(task.workspaceId, { type: created ? "diagnose.message.created" : "diagnose.message.updated", data: { sessionId: task.sessionId, message } });
		if (task.status !== "active") for (const listener of this.terminalListeners) listener(task);
	}
}
