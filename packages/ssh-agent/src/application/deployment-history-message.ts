import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** A UI history entry is never a user instruction, including during compaction. */
export function isDeploymentHistoryMessage(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === "deployment";
}

export function modelVisibleMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) => !isDeploymentHistoryMessage(message));
}
