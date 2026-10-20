import { deploymentMessageIdentity, type DeploymentConversationEntry } from "@/features/deploy/model/deployment-history-entry";
import { diagnoseHistoryIdentity, type DiagnoseConversationEntry } from "@/features/diagnose/model/diagnose-history-entry";
import type { ChatTimelineEntry } from "./chat-runtime-state";

export type ConversationHistoryEntry =
	| { kind: "message"; entry: ChatTimelineEntry }
	| DeploymentConversationEntry
	| DiagnoseConversationEntry;

/** Classify the unified Chat history; ordering, pagination and persistence stay on the existing path. */
export function conversationHistory(messages: ChatTimelineEntry[]): ConversationHistoryEntry[] {
	return messages.flatMap((entry): ConversationHistoryEntry[] => {
		if (entry.message.role === "system") return [];
		const deployment = deploymentMessageIdentity(entry);
		if (deployment) return [{ kind: "deploymentMessage", entry, ...deployment }];
		const diagnosis = diagnoseHistoryIdentity(entry.message);
		return [diagnosis ? { kind: "diagnoseMessage", entry, ...diagnosis } : { kind: "message", entry }];
	});
}
