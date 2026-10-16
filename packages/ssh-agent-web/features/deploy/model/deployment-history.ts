import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { DeploymentRun } from "./deployment";
import { deploymentMessageIdentity, type ConversationHistoryEntry } from "./deployment-history-entry";

export function newestDeploymentRun(first?: DeploymentRun | null, second?: DeploymentRun | null): DeploymentRun | null {
	if (!first) return second ?? null;
	if (!second || first.updatedAt >= second.updatedAt) return first;
	return second;
}

export function deploymentHistoryTime(run: DeploymentRun): number {
	return run.createdAt;
}

export function mergeDeploymentHistory(preferred: DeploymentRun[], other: DeploymentRun[]): DeploymentRun[] {
	const byId = new Map<string, DeploymentRun>();
	for (const run of [...preferred, ...other]) {
		const current = byId.get(run.id);
		if (!current || current.updatedAt < run.updatedAt) byId.set(run.id, run);
	}
	return [...byId.values()].sort((left, right) => deploymentHistoryTime(right) - deploymentHistoryTime(left) || right.id.localeCompare(left.id));
}

/** Rendering only: pagination and legacy placement are owned by the Chat history API. */
export function conversationHistory(messages: ChatTimelineEntry[]): ConversationHistoryEntry[] {
	return messages.flatMap((entry): ConversationHistoryEntry[] => {
		if (entry.message.role === "system") return [];
		const identity = deploymentMessageIdentity(entry);
		return [identity ? { kind: "deploymentMessage", entry, ...identity } : { kind: "message", entry }];
	});
}
