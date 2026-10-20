import type { DatabaseSync } from "node:sqlite";
import type { DiagnoseRepository } from "../../application/repositories/diagnose-repository.ts";
import type { ChatMessageProjection } from "../../domain/chat.ts";
import { DiagnoseError, isDiagnoseNodeStatus, type DiagnoseMutationResult, type DiagnoseNode, type DiagnoseRequestLink, type DiagnoseTask } from "../../domain/diagnose.ts";

export class SqliteDiagnoseRepository implements DiagnoseRepository {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) { this.database = database; }
	find(sessionId: string, taskId: string): DiagnoseTask | undefined {
		return parseTask(this.database.prepare("SELECT * FROM diagnose_tasks WHERE session_id = ? AND id = ?").get(sessionId, taskId));
	}
	active(sessionId: string): DiagnoseTask | undefined {
		return parseTask(this.database.prepare("SELECT * FROM diagnose_tasks WHERE session_id = ? AND status = 'active'").get(sessionId));
	}
	byRequest(sessionId: string, requestId: string): DiagnoseTask | undefined {
		return parseTask(this.database.prepare("SELECT * FROM diagnose_tasks WHERE session_id = ? AND request_id = ?").get(sessionId, requestId));
	}
	insert(task: DiagnoseTask): void {
		this.database.prepare(`INSERT INTO diagnose_tasks (id, session_id, workspace_id, request_id, title, status, revision, current_sequence, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'active', 1, 0, ?, ?)`).run(task.id, task.sessionId, task.workspaceId, task.requestId, task.title, task.createdAt, task.updatedAt);
	}
	update(task: DiagnoseTask, expectedRevision: number, conclusionMarkdown?: string): void {
		const result = this.database.prepare(`UPDATE diagnose_tasks SET title = ?, status = ?, revision = ?, current_sequence = ?,
			conclusion_markdown = COALESCE(?, conclusion_markdown), conclusion_request_json = ?, updated_at = ?, finished_at = ?
			WHERE id = ? AND session_id = ? AND status = 'active' AND revision = ?`).run(task.title, task.status, task.revision, task.currentSequence,
			conclusionMarkdown ?? null, task.conclusionRequest ? JSON.stringify(task.conclusionRequest) : null, task.updatedAt, task.finishedAt ?? null, task.id, task.sessionId, expectedRevision);
		if (result.changes !== 1) throw new DiagnoseError("diagnose_conflict", "Diagnosis changed before the update committed", 409);
	}
	current(taskId: string): DiagnoseNode | undefined {
		return parseNode(this.database.prepare("SELECT * FROM diagnose_nodes WHERE task_id = ? ORDER BY sequence DESC LIMIT 1").get(taskId));
	}
	nodes(taskId: string, beforeSequence: number | undefined, limit: number): DiagnoseNode[] {
		return this.database.prepare("SELECT * FROM diagnose_nodes WHERE task_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?")
			.all(taskId, beforeSequence ?? Number.MAX_SAFE_INTEGER, limit).map((row) => parseNode(row)!).reverse();
	}
	appendNode(node: DiagnoseNode): void {
		this.database.prepare(`INSERT INTO diagnose_nodes (task_id, sequence, direction, status, explanation, revision, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(node.taskId, node.sequence, node.direction, node.status, node.explanation, node.revision, node.createdAt, node.updatedAt);
	}
	updateCurrent(node: DiagnoseNode, expectedRevision: number): void {
		const result = this.database.prepare(`UPDATE diagnose_nodes SET direction = ?, status = ?, explanation = ?, revision = ?, updated_at = ?
			WHERE task_id = ? AND sequence = ? AND revision = ? AND EXISTS (SELECT 1 FROM diagnose_tasks WHERE id = ? AND status = 'active' AND current_sequence = ?)`)
			.run(node.direction, node.status, node.explanation, node.revision, node.updatedAt, node.taskId, node.sequence, expectedRevision, node.taskId, node.sequence);
		if (result.changes !== 1) throw new DiagnoseError("diagnose_node_conflict", "Only the active current record can change", 409);
	}
	conclusion(taskId: string): string | undefined {
		const row = this.database.prepare("SELECT conclusion_markdown FROM diagnose_tasks WHERE id = ?").get(taskId);
		return typeof row?.conclusion_markdown === "string" ? row.conclusion_markdown : undefined;
	}
	receipt(taskId: string, runId: string, toolCallId: string): { request: string; result: DiagnoseMutationResult } | undefined {
		const row = this.database.prepare("SELECT * FROM diagnose_tool_calls WHERE task_id = ? AND run_id = ? AND tool_call_id = ?").get(taskId, runId, toolCallId);
		if (!row) return undefined;
		const result = object(parseJson(row.result_json));
		if (typeof result.taskId !== "string" || !isTaskStatus(result.status) || !positive(result.revision) || typeof result.conclusionAvailable !== "boolean") throw corrupt();
		const node = result.currentNode === undefined ? undefined : parseReceiptNode(result.currentNode);
		return { request: String(row.request_json), result: { taskId: result.taskId, status: result.status,
			revision: Number(result.revision), conclusionAvailable: result.conclusionAvailable, ...(node ? { currentNode: node } : {}) } };
	}
	saveReceipt(taskId: string, runId: string, toolCallId: string, request: string, result: DiagnoseMutationResult): void {
		this.database.prepare("INSERT INTO diagnose_tool_calls VALUES (?, ?, ?, ?, ?)").run(taskId, runId, toolCallId, request, JSON.stringify(result));
	}
	bindRun(taskId: string, runId: string): void {
		this.database.prepare("INSERT INTO diagnose_chat_runs (task_id, run_id) VALUES (?, ?)").run(taskId, runId);
	}
	boundTask(runId: string): string | undefined {
		const row = this.database.prepare("SELECT task_id FROM diagnose_chat_runs WHERE run_id = ?").get(runId);
		return typeof row?.task_id === "string" ? row.task_id : undefined;
	}
	historyMessage(sessionId: string, taskId: string): ChatMessageProjection | undefined {
		const row = this.database.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND id = ? AND message_type = 'diagnose'").get(sessionId, `diagnose:${taskId}`);
		if (!row) return undefined;
		const message = object(parseJson(row.message_json));
		if (message.role !== "custom" || message.customType !== "diagnose" || typeof message.content !== "string" || !integer(message.timestamp) || typeof row.id !== "string" || !positive(row.sequence) || !integer(row.created_at)) throw corrupt();
		return { id: row.id, sequence: Number(row.sequence), createdAt: Number(row.created_at), message: { role: "custom", customType: "diagnose", content: message.content,
			display: true, timestamp: Number(message.timestamp), details: object(message.details) } };
	}
	requestLink(taskId: string, requestId: string): DiagnoseRequestLink | undefined {
		const row = this.database.prepare("SELECT * FROM diagnose_requests WHERE task_id = ? AND request_id = ?").get(taskId, requestId);
		return row ? parseLink({ requestId: row.request_id, runId: row.run_id, ...(row.queue_item_id ? { queueItemId: row.queue_item_id } : {}) }) : undefined;
	}
	saveRequestLink(taskId: string, link: DiagnoseRequestLink): void {
		this.database.prepare("INSERT INTO diagnose_requests (task_id, request_id, run_id, queue_item_id) VALUES (?, ?, ?, ?)")
			.run(taskId, link.requestId, link.runId, link.queueItemId ?? null);
	}
}

function parseTask(value: unknown): DiagnoseTask | undefined {
	if (value === undefined) return undefined;
	const row = object(value);
	if (![row.id, row.session_id, row.workspace_id, row.request_id, row.title].every((v) => typeof v === "string" && v.length > 0) ||
		!isTaskStatus(row.status) || !positive(row.revision) || !integer(row.current_sequence) || !integer(row.created_at) || !integer(row.updated_at) ||
		(row.finished_at !== null && !integer(row.finished_at)) || (row.conclusion_markdown !== null && typeof row.conclusion_markdown !== "string")) throw corrupt();
	return { id: String(row.id), sessionId: String(row.session_id), workspaceId: String(row.workspace_id), requestId: String(row.request_id), title: String(row.title),
		status: row.status, revision: Number(row.revision), currentSequence: Number(row.current_sequence), conclusionAvailable: row.conclusion_markdown !== null,
		createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
		...(row.conclusion_request_json === null ? {} : { conclusionRequest: parseLink(parseJson(row.conclusion_request_json)) }) };
}
function parseNode(value: unknown): DiagnoseNode | undefined {
	if (value === undefined) return undefined;
	const row = object(value);
	if (typeof row.task_id !== "string" || typeof row.direction !== "string" || !isDiagnoseNodeStatus(row.status) || typeof row.explanation !== "string" ||
		!positive(row.sequence) || !positive(row.revision) || !integer(row.created_at) || !integer(row.updated_at)) throw corrupt();
	return { taskId: row.task_id, sequence: Number(row.sequence), direction: row.direction, status: row.status, explanation: row.explanation,
		revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function parseLink(value: unknown): DiagnoseRequestLink {
	const row = object(value);
	if (typeof row.requestId !== "string" || typeof row.runId !== "string" || (row.queueItemId !== undefined && typeof row.queueItemId !== "string")) throw corrupt();
	return { requestId: row.requestId, runId: row.runId, ...(typeof row.queueItemId === "string" ? { queueItemId: row.queueItemId } : {}) };
}
function parseReceiptNode(value: unknown): DiagnoseNode {
	const node = object(value);
	return parseNode({ task_id: node.taskId, sequence: node.sequence, direction: node.direction, status: node.status,
		explanation: node.explanation, revision: node.revision, created_at: node.createdAt, updated_at: node.updatedAt })!;
}
function isTaskStatus(v: unknown): v is DiagnoseTask["status"] { return v === "active" || v === "completed" || v === "cancelled"; }
function integer(v: unknown): boolean { return Number.isSafeInteger(v) && Number(v) >= 0; }
function positive(v: unknown): boolean { return integer(v) && Number(v) > 0; }
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw corrupt();
	return value as Record<string, unknown>;
}
function parseJson(value: unknown): unknown {
	if (typeof value !== "string") throw corrupt();
	try { return JSON.parse(value); } catch { throw corrupt(); }
}
function corrupt(): DiagnoseError { return new DiagnoseError("diagnose_data_corrupt", "Saved diagnosis is invalid", 500); }
