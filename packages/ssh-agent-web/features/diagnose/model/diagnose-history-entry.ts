import { isRecord, type AgentMessage } from "@/features/chat/model/chat";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { DiagnoseStatus } from "./diagnose";

export interface DiagnoseHistoryIdentity { taskId: string; title: string; status: DiagnoseStatus }
export type DiagnoseConversationEntry = DiagnoseHistoryIdentity & { kind: "diagnoseMessage"; entry: ChatTimelineEntry };

export function diagnoseHistoryIdentity(message: AgentMessage): DiagnoseHistoryIdentity | undefined {
	if (message.role !== "custom" || message.customType !== "diagnose" || !isRecord(message.details)) return undefined;
	const { taskId, title, status } = message.details;
	return typeof taskId === "string" && taskId.length > 0 && typeof title === "string" && title.length > 0 &&
		(status === "active" || status === "completed" || status === "cancelled") ? { taskId, title, status } : undefined;
}
