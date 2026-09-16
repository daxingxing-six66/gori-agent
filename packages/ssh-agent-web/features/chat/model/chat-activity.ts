import { activeChatRun, type ChatRuntimeState } from "./chat-runtime-state";

export function waitingForChatResponse(state: ChatRuntimeState, loading: boolean, submitting: boolean): boolean {
	if (loading) return false;
	if (!activeChatRun(state.run)) return submitting;
	const runId = state.run.id;
	if (Object.values(state.approvals).some((approval) => approval.runId === runId && approval.status === "pending")) return false;
	return !state.timeline.some((entry) => entry.runId === runId && (
		entry.message.role === "toolResult" ||
		(entry.message.role === "assistant" && entry.message.content.some((part) =>
			part.type === "toolCall" || (part.type === "text" && part.text.length > 0) || (part.type === "thinking" && (part.thinking.length > 0 || part.redacted === true)),
		))
	));
}
