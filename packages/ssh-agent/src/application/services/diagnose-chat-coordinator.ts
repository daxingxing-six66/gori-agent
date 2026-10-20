import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatRun } from "../../domain/chat.ts";
import { DiagnoseError, type DiagnoseRequestLink, type DiagnoseTask } from "../../domain/diagnose.ts";
import type { ChatRepository } from "../repositories/chat-repository.ts";
import type { ChatService } from "./chat-service.ts";
import type { DiagnoseService } from "./diagnose-service.ts";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.ts";

export interface DiagnoseChatInput {
	requestId: string; problem?: string; attachmentIds?: string[]; providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel;
	serverInteractionMode?: "command" | "terminal";
}
export interface DiagnoseChatResult { task: DiagnoseTask; run?: ChatRun; queueItemId?: string }

/** User actions use the original Chat scheduling, not a second diagnosis agent or scheduler. */
export class DiagnoseChatCoordinator {
	private readonly options: { diagnoses: DiagnoseService; chat: ChatService; repository: ChatRepository; lifecycle: SessionLifecycleCoordinator };
	private readonly pending = new Map<string, Promise<unknown>>();
	constructor(options: DiagnoseChatCoordinator["options"]) {
		this.options = options;
		options.diagnoses.onTerminal((task) => {
			const link = task.conclusionRequest;
			if (!link?.queueItemId) return;
			try {
				if (options.repository.findPendingQueueBehavior(task.sessionId, link.runId, link.queueItemId))
					options.chat.cancelQueued(task.sessionId, link.runId, link.queueItemId);
			} catch (error) { console.warn("Diagnosis ended, but its queued conclusion could not be cancelled", { taskId: task.id, error }); }
		});
	}
	start(sessionId: string, input: DiagnoseChatInput): Promise<DiagnoseChatResult> {
		return this.serial(sessionId, async () => {
			const prior = this.options.diagnoses.byRequest(sessionId, input.requestId);
			const active = this.options.diagnoses.active(sessionId);
			const task = prior ?? active ?? await this.options.chat.initializeTask(sessionId, () => this.options.diagnoses.create(sessionId, input.requestId));
			const existing = this.options.diagnoses.requestLink(task.id, input.requestId);
			if (existing) return this.result(task, existing);
			if (task.status !== "active" || (active && !prior && !input.problem?.trim() && !input.attachmentIds?.length)) return { task };
			const message = input.problem?.trim() || "开始诊断服务器问题。请先与我明确需要排查的问题。";
			return this.submit(task, input, message, false);
		});
	}
	conclude(sessionId: string, taskId: string, input: DiagnoseChatInput): Promise<DiagnoseChatResult> {
		return this.serial(sessionId, async () => {
			const task = this.options.diagnoses.get(sessionId, taskId);
			if (task.status !== "active") return { task };
			const link = this.options.diagnoses.requestLink(taskId, input.requestId) ?? task.conclusionRequest;
			if (link && (link.requestId === input.requestId || this.inFlight(task, link))) return this.result(task, link);
			return this.submit(task, input,
				"请根据已有排查信息整理 Markdown 结论，调用 diagnose_finish 保存并结束本次诊断。信息不足以定位也可以明确说明。请使用已有事实整理，不为完成结论额外启动排查循环。保存后在对话中简短告知。", true);
		});
	}
	async cancel(sessionId: string, taskId: string): Promise<DiagnoseTask> {
		// Commit first: neither a queued summary nor a late tool result may revive the task.
		const lease = this.options.lifecycle.acquireUse(sessionId, "diagnose_request");
		try {
			const task = await this.options.diagnoses.cancel(sessionId, taskId);
			const run = this.options.repository.findLatestRun(sessionId);
			if (task.status === "cancelled" && run && this.options.diagnoses.boundTask(run.id) === taskId && (run.status === "pending" || run.status === "running"))
				await this.options.chat.cancelRunAndWait(sessionId, run.id);
			return task;
		} finally { lease.release(); }
	}
	private async submit(task: DiagnoseTask, input: DiagnoseChatInput, message: string, conclusion: boolean): Promise<DiagnoseChatResult> {
		const current = this.options.diagnoses.get(task.sessionId, task.id);
		if (current.status !== "active") return { task: current };
		const requestId = `diagnose:${task.id}:${input.requestId}`;
		const durableRun = this.options.repository.findRunByRequest(task.sessionId, requestId);
		const queued = this.options.repository.findQueueItemByRequest(task.sessionId, requestId);
		let run = durableRun ?? await this.options.chat.getActiveRun(task.sessionId);
		let queueItemId: string | undefined = queued?.id;
		if (run && !durableRun) {
			if (this.options.diagnoses.boundTask(run.id) !== task.id)
				throw new DiagnoseError("diagnose_run_mismatch", "The active Chat Run is not bound to this diagnosis", 409);
			queueItemId ??= (await this.options.chat.enqueue(task.sessionId, run.id, { requestId, behavior: "follow_up", message, attachmentIds: input.attachmentIds })).id;
		} else if (!run) {
			run = await this.options.chat.createRun({ ...input, sessionId: task.sessionId, requestId, message,
				serverInteractionMode: input.serverInteractionMode ?? "command" });
		}
		const link: DiagnoseRequestLink = { requestId: input.requestId, runId: run.id, ...(queueItemId ? { queueItemId } : {}) };
		await this.options.diagnoses.saveRequestLink(task.sessionId, task.id, link, conclusion);
		// A direct exit can win while createRun/enqueue is awaited. Settle only this bound Run.
		const latest = this.options.diagnoses.get(task.sessionId, task.id);
		if (latest.status !== "active" && queueItemId && this.options.repository.findPendingQueueBehavior(task.sessionId, run.id, queueItemId))
			this.options.chat.cancelQueued(task.sessionId, run.id, queueItemId);
		if (latest.status === "cancelled") await this.options.chat.cancelRunAndWait(task.sessionId, run.id);
		return this.result(latest, link);
	}
	private result(task: DiagnoseTask, link: DiagnoseRequestLink): DiagnoseChatResult {
		const run = this.options.repository.findRun(link.runId, task.sessionId);
		return { task, ...(run ? { run } : {}), ...(link.queueItemId ? { queueItemId: link.queueItemId } : {}) };
	}
	private inFlight(task: DiagnoseTask, link: DiagnoseRequestLink): boolean {
		const run = this.options.repository.findRun(link.runId, task.sessionId);
		if (!run || (run.status !== "pending" && run.status !== "running")) return false;
		if (!link.queueItemId) return true;
		return !this.options.repository.listQueue(task.sessionId, run.id, "cancelled").some((item) => item.id === link.queueItemId);
	}
	private async serial<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.pending.get(sessionId);
		const task = Promise.resolve(previous).catch(() => undefined).then(async () => {
			const lease = this.options.lifecycle.acquireUse(sessionId, "diagnose_request");
			try { return await action(); } finally { lease.release(); }
		});
		this.pending.set(sessionId, task);
		try { return await task; } finally { if (this.pending.get(sessionId) === task) this.pending.delete(sessionId); }
	}
}
