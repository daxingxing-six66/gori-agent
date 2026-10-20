import type { ChatMessageProjection } from "../../domain/chat.ts";
import type { DiagnoseMutationResult, DiagnoseNode, DiagnoseRequestLink, DiagnoseTask } from "../../domain/diagnose.ts";

export interface DiagnoseRepository {
	find(sessionId: string, taskId: string): DiagnoseTask | undefined;
	active(sessionId: string): DiagnoseTask | undefined;
	byRequest(sessionId: string, requestId: string): DiagnoseTask | undefined;
	insert(task: DiagnoseTask): void;
	update(task: DiagnoseTask, expectedRevision: number, conclusionMarkdown?: string): void;
	current(taskId: string): DiagnoseNode | undefined;
	nodes(taskId: string, beforeSequence: number | undefined, limit: number): DiagnoseNode[];
	appendNode(node: DiagnoseNode): void;
	updateCurrent(node: DiagnoseNode, expectedRevision: number): void;
	conclusion(taskId: string): string | undefined;
	receipt(taskId: string, runId: string, toolCallId: string): { request: string; result: DiagnoseMutationResult } | undefined;
	saveReceipt(taskId: string, runId: string, toolCallId: string, request: string, result: DiagnoseMutationResult): void;
	bindRun(taskId: string, runId: string): void;
	boundTask(runId: string): string | undefined;
	historyMessage(sessionId: string, taskId: string): ChatMessageProjection | undefined;
	requestLink(taskId: string, requestId: string): DiagnoseRequestLink | undefined;
	saveRequestLink(taskId: string, link: DiagnoseRequestLink): void;
}
