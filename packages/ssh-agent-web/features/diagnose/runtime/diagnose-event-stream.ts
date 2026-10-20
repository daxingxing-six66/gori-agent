import { subscribeWorkspaceEvents } from "@/shared/events/workspace-events";
import type { SupportedLocale } from "@/features/i18n/model/locale";
import { isAgentMessage, isRecord, type ChatMessage } from "@/features/chat/model/chat";
import { isDiagnoseNode, isDiagnoseTask, type DiagnoseNode, type DiagnoseTask } from "../model/diagnose";

export function subscribeDiagnoseEvents(options: { sessionId: string; workspaceId: string; locale: SupportedLocale;
	onTask(task: DiagnoseTask): void; onNode(node: DiagnoseNode): void; onMessage(message: ChatMessage): void; onReconnect(): void }): () => void {
	const events: Record<string, (event: Event) => void> = {};
	const listen = (type: string, accept: (value: unknown) => void) => { events[type] = (event) => {
		if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
		let value: unknown; try { value = JSON.parse(event.data); } catch { return; } accept(value);
	}; };
	listen("diagnose.task.updated", (value) => { if (isDiagnoseTask(value) && value.sessionId === options.sessionId && value.workspaceId === options.workspaceId) options.onTask(value); });
	listen("diagnose.node.updated", (value) => { if (isRecord(value) && value.sessionId === options.sessionId && value.workspaceId === options.workspaceId && isDiagnoseNode(value.node)) options.onNode(value.node); });
	for (const type of ["diagnose.message.created", "diagnose.message.updated"]) listen(type, (value) => {
		if (!isRecord(value) || value.sessionId !== options.sessionId || !isRecord(value.message)) return;
		const entry = value.message;
		if (typeof entry.id === "string" && typeof entry.sequence === "number" && Number.isSafeInteger(entry.sequence) && entry.sequence > 0 && typeof entry.createdAt === "number" &&
			isAgentMessage(entry.message) && entry.message.role === "custom" && entry.message.customType === "diagnose")
			options.onMessage({ id: entry.id, sequence: entry.sequence, createdAt: entry.createdAt, message: entry.message });
	});
	events["stream.ready"] = () => options.onReconnect();
	return subscribeWorkspaceEvents({ workspaceId: options.workspaceId, locale: options.locale, topics: ["diagnoses"], events });
}
