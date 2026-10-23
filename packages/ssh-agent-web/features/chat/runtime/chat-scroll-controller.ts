import { chatScrollBehavior, type ChatScrollMetrics } from "../model/chat-scroll";

export interface ChatScrollViewport extends ChatScrollMetrics {
	scrollTo(options: ScrollToOptions): void;
}

/** User reading intent survives render updates and same-position native scroll events. */
export class ChatScrollController {
	private following = true;
	private previousTop: number | null = null;

	get followNewContent(): boolean { return this.following; }

	contentChanged(viewport: ChatScrollViewport, loading: boolean): void {
		if (!loading && this.following) this.resume(viewport);
	}

	pause(viewport: ChatScrollViewport): void {
		this.following = false;
		this.rememberPosition(viewport);
		// Cancel an already running smooth animation before the browser applies the user's gesture.
		viewport.scrollTo({ top: viewport.scrollTop, behavior: "instant" });
	}

	scrolled(viewport: ChatScrollViewport): void {
		const previous = this.previousTop;
		const atBottom = chatScrollBehavior(viewport).followNewContent;
		if (previous !== null && viewport.scrollTop < previous) { this.pause(viewport); return; }
		else if (previous !== null && viewport.scrollTop > previous && atBottom) this.following = true;
		else if (!atBottom) this.following = false;
		this.rememberPosition(viewport);
	}

	resume(viewport: ChatScrollViewport): void {
		this.following = true;
		// Streaming output never leaves a native animation competing with subsequent user input.
		viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
		this.rememberPosition(viewport);
	}

	rememberPosition(viewport: ChatScrollMetrics): void { this.previousTop = viewport.scrollTop; }

	showReturnToBottom(viewport: ChatScrollMetrics): boolean {
		return !this.following && viewport.scrollHeight > viewport.clientHeight;
	}
}

export interface ChatScrollAnchor {
	element: Element;
	offset: number;
}

/** Anchor an existing visible row, so growth at the live tail is never counted as prepended history. */
export function captureChatScrollAnchor(viewport: HTMLElement): ChatScrollAnchor | null {
	const top = viewport.getBoundingClientRect().top;
	const rows = viewport.querySelector(".chat-timeline")?.children;
	if (!rows) return null;
	for (const element of rows) {
		if (element.getAttribute("role") === "status") continue;
		const rect = element.getBoundingClientRect();
		if (rect.bottom > top) return { element, offset: rect.top - top };
	}
	return null;
}

export function restoreChatScrollAnchor(viewport: HTMLElement, anchor: ChatScrollAnchor): void {
	if (!viewport.contains(anchor.element)) return;
	const offset = anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
	if (offset !== anchor.offset) viewport.scrollTop += offset - anchor.offset;
}
