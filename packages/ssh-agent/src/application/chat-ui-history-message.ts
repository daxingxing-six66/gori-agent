import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** A UI history entry is never a user instruction, including during compaction. */
export function isChatUiHistoryMessage(message: AgentMessage): boolean {
	return message.role === "custom" && (message.customType === "deployment" || message.customType === "diagnose");
}

export function modelVisibleMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) => !isChatUiHistoryMessage(message));
}
