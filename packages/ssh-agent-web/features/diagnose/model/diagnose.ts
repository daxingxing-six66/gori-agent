import { isRecord } from "@/features/chat/model/chat";

export type DiagnoseStatus = "active" | "completed" | "cancelled";
export type DiagnoseNodeStatus = "diagnosing" | "confirmed" | "unconfirmed";
export interface DiagnoseRequestLink { requestId: string; runId: string; queueItemId?: string }
export interface DiagnoseTask {
	id: string; sessionId: string; workspaceId: string; requestId: string; title: string; status: DiagnoseStatus;
	revision: number; currentSequence: number; conclusionAvailable: boolean; conclusionRequest?: DiagnoseRequestLink;
	createdAt: number; updatedAt: number; finishedAt?: number;
}
export interface DiagnoseNode {
	taskId: string; sequence: number; direction: string; status: DiagnoseNodeStatus; explanation: string;
	revision: number; createdAt: number; updatedAt: number;
}
export interface DiagnoseNodePage { nodes: DiagnoseNode[]; nextBeforeSequence: number | null }
const integer = (value: unknown, min = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
export function isDiagnoseTask(value: unknown): value is DiagnoseTask {
	return isRecord(value) && [value.id, value.sessionId, value.workspaceId, value.requestId, value.title].every((v) => typeof v === "string" && v.length > 0) &&
		(value.status === "active" || value.status === "completed" || value.status === "cancelled") && integer(value.revision, 1) && integer(value.currentSequence) &&
		typeof value.conclusionAvailable === "boolean" && integer(value.createdAt) && integer(value.updatedAt) &&
		(value.finishedAt === undefined || integer(value.finishedAt)) && (value.conclusionRequest === undefined || isRequestLink(value.conclusionRequest));
}
function isRequestLink(value: unknown): value is DiagnoseRequestLink {
	return isRecord(value) && typeof value.requestId === "string" && typeof value.runId === "string" && (value.queueItemId === undefined || typeof value.queueItemId === "string");
}
export function isDiagnoseNode(value: unknown): value is DiagnoseNode {
	return isRecord(value) && typeof value.taskId === "string" && typeof value.direction === "string" && typeof value.explanation === "string" &&
		(value.status === "diagnosing" || value.status === "confirmed" || value.status === "unconfirmed") && integer(value.sequence, 1) && integer(value.revision, 1) &&
		integer(value.createdAt) && integer(value.updatedAt);
}
export function mergeDiagnoseNodes(current: DiagnoseNode[], incoming: DiagnoseNode[]): DiagnoseNode[] {
	const bySequence = new Map(current.map((node) => [node.sequence, node]));
	for (const node of incoming) if (!bySequence.has(node.sequence) || bySequence.get(node.sequence)!.revision < node.revision) bySequence.set(node.sequence, node);
	return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}
export function newerDiagnoseTask(current: DiagnoseTask | undefined, incoming: DiagnoseTask): DiagnoseTask {
	return current && (current.revision >= incoming.revision || current.status !== "active" && incoming.status === "active") ? current : incoming;
}
