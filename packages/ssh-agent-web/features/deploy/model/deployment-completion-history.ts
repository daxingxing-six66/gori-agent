import type { ChatToolExecution } from "@/features/chat/model/chat";
import type { ConversationHistoryEntry } from "@/features/chat/model/conversation-history";
import { completedToolResultObjects, taskCompletionHistory } from "@/features/chat/model/task-completion-history";
import { deploymentEntryId, deploymentEntrySummary, type DeploymentConversationEntry } from "./deployment-history-entry";

/** Deploy owns completion validation; the shared projector owns splitting, placement and deduplication. */
export function deploymentCompletionHistory(entries: ConversationHistoryEntry[], tools: Record<string, ChatToolExecution>): ConversationHistoryEntry[] {
	return taskCompletionHistory(entries, tools, {
		message: (entry) => entry.kind === "message" ? entry.entry : undefined,
		cardId: (entry) => isDeploymentEntry(entry) ? deploymentEntryId(entry) : undefined,
		wrapMessage: (entry) => ({ kind: "message", entry }),
		match: (tool, execution, cards) => {
			if (tool.name !== "deployment_finish") return undefined;
			for (const result of completedToolResultObjects(execution, tool.name)) {
				if (typeof result.deploymentId !== "string" || result.deploymentId.length === 0 || result.deploymentMode !== false ||
					(result.outcome !== "success" && result.outcome !== "failed") || tool.arguments.outcome !== result.outcome) continue;
				const card = cards.get(result.deploymentId);
				if (card && isDeploymentEntry(card) && deploymentEntrySummary(card).status === result.outcome) return card;
			}
			return undefined;
		},
	});
}

function isDeploymentEntry(entry: ConversationHistoryEntry): entry is DeploymentConversationEntry {
	return entry.kind === "deploymentMessage" || entry.kind === "deployment" || entry.kind === "discussion";
}
