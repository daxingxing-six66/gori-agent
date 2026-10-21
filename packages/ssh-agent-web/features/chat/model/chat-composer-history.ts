import type { AgentMessage } from "@/features/chat/model/chat";
import { hasChatComposerContent } from "@/features/chat/model/chat-composer";

export const chatComposerHistoryLimit = 7;
export type ChatComposerHistoryDirection = "older" | "newer";

/** Preserve message order and repeated messages; only user-authored text is editable. */
export function recentChatComposerMessages(timeline: readonly { message: AgentMessage }[]): string[] {
	const messages: string[] = [];
	for (let index = timeline.length - 1; index >= 0 && messages.length < chatComposerHistoryLimit; index -= 1) {
		const message = timeline[index]!.message;
		if (message.role !== "user") continue;
		const text = typeof message.content === "string" ? message.content
			: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		if (hasChatComposerContent(text)) messages.push(text);
	}
	return messages;
}
