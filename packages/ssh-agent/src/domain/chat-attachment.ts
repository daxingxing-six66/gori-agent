import type { UserMessage } from "@earendil-works/pi-ai";

export const MAX_CHAT_ATTACHMENTS = 4;

export type ChatAttachmentKind = "image" | "text";

export interface ChatAttachmentKindReference {
	readonly id: string;
	readonly kind: ChatAttachmentKind;
}

export interface ChatUserMessage extends UserMessage {
	attachmentIds?: string[];
	/** Server-validated types; absent on legacy image-only messages. */
	attachmentKinds?: Record<string, ChatAttachmentKind>;
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
	attachments: readonly ChatAttachmentKindReference[] = [],
): ChatUserMessage {
	return {
		role: "user",
		content: message,
		...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
		...(attachments.some((attachment) => attachment.kind === "text")
			? { attachmentKinds: Object.fromEntries(attachments.map(({ id, kind }) => [id, kind])) }
			: {}),
		timestamp,
	};
}
