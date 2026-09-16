import type { UserMessage } from "@earendil-works/pi-ai";

export const MAX_CHAT_IMAGE_ATTACHMENTS = 4;

export interface ChatUserMessage extends UserMessage {
	attachmentIds?: string[];
}

export function attachmentIdsFromMessage(message: unknown): readonly string[] {
	if (message === null || typeof message !== "object" || !("role" in message) || message.role !== "user") return [];
	if (!("attachmentIds" in message) || !Array.isArray(message.attachmentIds)) return [];
	return message.attachmentIds.filter((value): value is string => typeof value === "string");
}

export function createChatUserMessage(
	message: string,
	attachmentIds: readonly string[],
	timestamp: number,
): ChatUserMessage {
	return {
		role: "user",
		content: message,
		...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
		timestamp,
	};
}
