import { chatApi } from "@/features/chat/api/chat-api";
import type { ChatMessage } from "@/features/chat/model/chat";

export async function listMessagePages(sessionId: string, afterSequence: number): Promise<ChatMessage[]> {
	const messages: ChatMessage[] = [];
	let cursor = afterSequence;
	for (;;) {
		const response = await chatApi.listMessages(sessionId, { afterSequence: cursor, limit: 100 });
		messages.push(...response.messages);
		if (response.nextSequence === null || response.messages.length === 0) return messages;
		cursor = response.messages.at(-1)?.sequence ?? cursor;
	}
}
