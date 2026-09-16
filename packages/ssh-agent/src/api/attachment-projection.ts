import type { Attachment } from "../domain/attachment.ts";
import type { ChatMessageProjection } from "../domain/chat.ts";
import type { AttachmentResponse, ChatMessageResponse, ListChatMessagesResponse } from "./contracts.ts";

export function attachmentResponse(attachment: Attachment): AttachmentResponse {
	return {
		...attachment,
		contentUrl: `/api/sessions/${encodeURIComponent(attachment.sessionId)}/attachments/${encodeURIComponent(attachment.id)}/content`,
	};
}

export function chatMessageListResponse(input: {
	readonly messages: ChatMessageProjection[];
	readonly nextBeforeSequence: number | null;
	readonly nextSequence: number | null;
}): ListChatMessagesResponse {
	return {
		...input,
		messages: input.messages.map(chatMessageResponse),
	};
}

function chatMessageResponse(message: ChatMessageProjection): ChatMessageResponse {
	const { attachments, ...projection } = message;
	return {
		...projection,
		...(attachments === undefined
			? {}
			: { attachments: attachments.map((attachment) => attachmentResponse(attachment)) }),
	};
}
