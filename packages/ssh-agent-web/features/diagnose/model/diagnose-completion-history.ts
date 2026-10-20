import type { ChatToolExecution } from "@/features/chat/model/chat";
import type { ConversationHistoryEntry } from "@/features/chat/model/conversation-history";
import { completedToolResultObjects, taskCompletionHistory } from "@/features/chat/model/task-completion-history";

/** A saved report and the exact durable diagnosis must agree before replacing diagnose_finish. */
export function diagnoseCompletionHistory(entries: ConversationHistoryEntry[], tools: Record<string, ChatToolExecution>): ConversationHistoryEntry[] {
	return taskCompletionHistory(entries, tools, {
		message: (entry) => entry.kind === "message" ? entry.entry : undefined,
		cardId: (entry) => entry.kind === "diagnoseMessage" ? entry.taskId : undefined,
		wrapMessage: (entry) => ({ kind: "message", entry }),
		match: (tool, execution, cards) => {
			if (tool.name !== "diagnose_finish") return undefined;
			for (const result of completedToolResultObjects(execution, tool.name)) {
				if (typeof result.taskId !== "string" || result.status !== "completed" || result.conclusionAvailable !== true) continue;
				const card = cards.get(result.taskId);
				if (card?.kind === "diagnoseMessage" && card.status === "completed") return card;
			}
			return undefined;
		},
	});
}
