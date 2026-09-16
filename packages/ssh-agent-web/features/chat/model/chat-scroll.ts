export const CHAT_BOTTOM_DISTANCE_THRESHOLD = 220;
export const CHAT_TOP_DISTANCE_THRESHOLD = 120;

export interface ChatScrollMetrics {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

export function chatScrollBehavior({ scrollHeight, scrollTop, clientHeight }: ChatScrollMetrics): {
	followNewContent: boolean;
	showReturnToBottom: boolean;
} {
	const distanceToBottom = Math.max(0, scrollHeight - scrollTop - clientHeight);
	return {
		followNewContent: distanceToBottom <= CHAT_BOTTOM_DISTANCE_THRESHOLD,
		showReturnToBottom: distanceToBottom > CHAT_BOTTOM_DISTANCE_THRESHOLD,
	};
}

export function isNearChatHistoryTop(scrollTop: number): boolean {
	return scrollTop <= CHAT_TOP_DISTANCE_THRESHOLD;
}
