import { subscribeWorkspaceEvents } from "@/shared/events/workspace-events";
import type { SupportedLocale } from "@/features/i18n/model/locale";
import { isAgentMessage, isRecord, type ChatMessage } from "@/features/chat/model/chat";
import { isDeploymentDiscussion, isDeploymentRun, type DeploymentDiscussion, type DeploymentRun } from "../model/deployment";
import { isDeploymentTask, isDeploymentLogChunk, type DeploymentTask, type DeploymentLogChunk } from "../model/deployment-task";

export function subscribeDeploymentEvents(options: {
	sessionId: string; workspaceId: string; locale: SupportedLocale;
	onRun(run: DeploymentRun): void; onDiscussion(discussion: DeploymentDiscussion): void;
	onTask(task: DeploymentTask): void; onLog(chunk: DeploymentLogChunk): void; onMessage?(message: ChatMessage): void;
	onReconnect(): void;
}): () => void {
	const events: Record<string, (event: Event) => void> = {};
	const listen = (type: string, accept: (value: unknown) => void) => { events[type] = (event) => {
		if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
		let value: unknown;
		try { value = JSON.parse(event.data); } catch { return; }
		accept(value);
	}; };
	listen("deployment.updated", (value) => {
		if (isDeploymentRun(value) && value.sessionId === options.sessionId && value.workspaceId === options.workspaceId) options.onRun(value);
	});
	listen("deployment.discussion.updated", (value) => {
		if (isDeploymentDiscussion(value) && value.sessionId === options.sessionId && value.workspaceId === options.workspaceId) options.onDiscussion(value);
	});
	for (const event of ["deployment.started", "deployment.finished"]) listen(event, (value) => {
		if (isDeploymentTask(value) && value.deployment.sessionId === options.sessionId && value.deployment.workspaceId === options.workspaceId) options.onTask(value);
	});
	listen("deployment.log.appended", (value) => {
		if (isDeploymentLogChunk(value) && "sessionId" in value && value.sessionId === options.sessionId) options.onLog(value);
	});
	for (const type of ["deployment.message.created", "deployment.message.updated"]) listen(type, (value) => {
		if (!isRecord(value) || value.sessionId !== options.sessionId || !isRecord(value.message)) return;
		const entry = value.message;
		if (isAgentMessage(entry.message) && entry.message.role === "custom" && entry.message.customType === "deployment" &&
			typeof entry.id === "string" && typeof entry.sequence === "number" && Number.isSafeInteger(entry.sequence) && entry.sequence > 0 &&
			typeof entry.createdAt === "number" && Number.isSafeInteger(entry.createdAt))
			options.onMessage?.({ id: entry.id, sequence: entry.sequence, createdAt: entry.createdAt, message: entry.message,
				...(typeof entry.runId === "string" ? { runId: entry.runId } : {}) });
	});
	events["stream.ready"] = () => options.onReconnect();
	return subscribeWorkspaceEvents({ workspaceId: options.workspaceId, locale: options.locale, topics: ["deployments"], events });
}
