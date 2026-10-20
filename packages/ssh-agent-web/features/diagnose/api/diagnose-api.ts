import { apiRequest } from "@/shared/api/client";
import { isChatRun, isRecord, type ChatRun } from "@/features/chat/model/chat";
import type { ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import { isDiagnoseTask, isDiagnoseNode, type DiagnoseTask, type DiagnoseNodePage } from "../model/diagnose";

export interface DiagnoseChatInput { requestId: string; problem?: string; attachmentIds?: string[]; providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel; serverInteractionMode: "command" | "terminal" }
export interface DiagnoseChatResult { task: DiagnoseTask; run?: ChatRun; queueItemId?: string }
const root = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/diagnoses`;
function task(value: unknown, sessionId: string, taskId?: string): DiagnoseTask {
	if (!isDiagnoseTask(value) || value.sessionId !== sessionId || taskId !== undefined && value.id !== taskId) throw new Error("Invalid diagnosis response");
	return value;
}
async function action(sessionId: string, suffix: string, input: DiagnoseChatInput): Promise<DiagnoseChatResult> {
	const value: unknown = await apiRequest(`${root(sessionId)}${suffix}`, { method: "POST", body: input });
	if (!isRecord(value) || value.run !== undefined && (!isChatRun(value.run) || value.run.sessionId !== sessionId) || value.queueItemId !== undefined && typeof value.queueItemId !== "string") throw new Error("Invalid diagnosis Chat response");
	return { task: task(value.task, sessionId), ...(isChatRun(value.run) ? { run: value.run } : {}), ...(typeof value.queueItemId === "string" ? { queueItemId: value.queueItemId } : {}) };
}
export const diagnoseApi = {
	async active(sessionId: string): Promise<DiagnoseTask | null> {
		const value: unknown = await apiRequest(`${root(sessionId)}/active`);
		return value === null ? null : task(value, sessionId);
	},
	async get(sessionId: string, taskId: string): Promise<DiagnoseTask> { return task(await apiRequest(`${root(sessionId)}/${encodeURIComponent(taskId)}`), sessionId, taskId); },
	async nodes(sessionId: string, taskId: string, beforeSequence?: number, signal?: AbortSignal): Promise<DiagnoseNodePage> {
		const value: unknown = await apiRequest(`${root(sessionId)}/${encodeURIComponent(taskId)}/nodes${beforeSequence === undefined ? "" : `?beforeSequence=${beforeSequence}`}`, { signal });
		if (!isRecord(value) || !Array.isArray(value.nodes) || !value.nodes.every((node) => isDiagnoseNode(node) && node.taskId === taskId && (beforeSequence === undefined || node.sequence < beforeSequence)) ||
			(value.nextBeforeSequence !== null && (!Number.isSafeInteger(value.nextBeforeSequence) || Number(value.nextBeforeSequence) < 1)) ||
			value.nodes.some((node, index, nodes) => index > 0 && node.sequence !== nodes[index - 1].sequence + 1)) throw new Error("Invalid diagnosis records response");
		return { nodes: value.nodes, nextBeforeSequence: value.nextBeforeSequence as number | null };
	},
	start: (sessionId: string, input: DiagnoseChatInput) => action(sessionId, "", input),
	conclude: (sessionId: string, taskId: string, input: DiagnoseChatInput) => action(sessionId, `/${encodeURIComponent(taskId)}/conclusion-requests`, input),
	async cancel(sessionId: string, taskId: string): Promise<DiagnoseTask> { return task(await apiRequest(`${root(sessionId)}/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }), sessionId, taskId); },
	async conclusion(sessionId: string, taskId: string): Promise<string> {
		const value: unknown = await apiRequest(`${root(sessionId)}/${encodeURIComponent(taskId)}/conclusion`);
		if (!isRecord(value) || typeof value.markdown !== "string" || !value.markdown.trim()) throw new Error("Invalid diagnosis conclusion response");
		return value.markdown;
	},
};
