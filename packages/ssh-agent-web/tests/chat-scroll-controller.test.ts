import { describe, expect, it, vi } from "vitest";
import { captureChatScrollAnchor, ChatScrollController, restoreChatScrollAnchor, type ChatScrollViewport } from "../features/chat/runtime/chat-scroll-controller";

function viewport(initialTop = 0) {
	let position = initialTop;
	const element = {
		scrollHeight: 1_200,
		clientHeight: 600,
		get scrollTop() { return position; },
		set scrollTop(value: number) { position = Math.max(0, Math.min(value, element.scrollHeight - element.clientHeight)); },
		scrollTo: vi.fn((options: ScrollToOptions) => { element.scrollTop = options.top ?? element.scrollTop; }),
	} satisfies ChatScrollViewport;
	return element;
}

function ready() {
	const element = viewport();
	const controller = new ChatScrollController();
	controller.contentChanged(element, false);
	element.scrollTo.mockClear();
	return { element, controller };
}

describe("chat output following yields to reading history", () => {
	it("waits for initial history, then follows incremental rendering with instant writes", () => {
		const element = viewport(); const controller = new ChatScrollController();
		controller.contentChanged(element, true);
		expect(element.scrollTo).not.toHaveBeenCalled();
		controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(600);
		element.scrollHeight += 75; controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(675);
		expect(element.scrollTo.mock.calls.every(([options]) => options.behavior === "instant")).toBe(true);
		expect(controller.followNewContent).toBe(true);
		expect(controller.showReturnToBottom(element)).toBe(false);
	});

	it("pauses on a one-pixel upward scroll without waiting to leave the old 220-pixel area", () => {
		const { element, controller } = ready();
		element.scrollTop -= 1; controller.scrolled(element);
		expect(controller.followNewContent).toBe(false);
		element.scrollTo.mockClear();
		element.scrollHeight += 40; controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(599);
		expect(element.scrollTo).not.toHaveBeenCalled();
		expect(controller.showReturnToBottom(element)).toBe(true);
	});

	it("cancels an existing smooth scroll immediately before the native upward input scrolls", () => {
		const { element, controller } = ready();
		controller.pause(element);
		expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: "instant" });
		expect(controller.followNewContent).toBe(false);
		// Cancelling an animation can deliver a same-position scroll event at the old bottom.
		controller.scrolled(element);
		expect(controller.followNewContent).toBe(false);
		element.scrollTo.mockClear(); element.scrollHeight += 25;
		controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(600);
		expect(element.scrollTo).not.toHaveBeenCalled();
	});

	it("keeps manual reading in control across repeated output and completion renders", () => {
		const { element, controller } = ready(); controller.pause(element);
		element.scrollTop = 450; controller.scrolled(element); element.scrollTo.mockClear();
		for (let update = 0; update < 10; update++) { element.scrollHeight += 20; controller.contentChanged(element, false); }
		expect(element.scrollTop).toBe(450);
		expect(controller.followNewContent).toBe(false);
		expect(element.scrollTo).not.toHaveBeenCalled();
	});

	it("does not resume merely because a downward movement is inside the old near-bottom range", () => {
		const { element, controller } = ready(); element.scrollTop = 300; controller.scrolled(element);
		element.scrollTop = 500; controller.scrolled(element);
		expect(controller.followNewContent).toBe(false);
		element.scrollTo.mockClear();
		element.scrollHeight += 15; controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(500);
		expect(element.scrollTo).not.toHaveBeenCalled();
	});

	it("resumes only on downward movement that reaches the actual bottom within rounding tolerance", () => {
		const { element, controller } = ready(); controller.pause(element);
		element.scrollTop = 300; controller.scrolled(element);
		element.scrollTop = 597.5; controller.scrolled(element);
		expect(controller.followNewContent).toBe(false);
		element.scrollTop = 598; controller.scrolled(element);
		expect(controller.followNewContent).toBe(true);
		element.scrollTo.mockClear(); element.scrollHeight += 50; controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(650);
		expect(controller.showReturnToBottom(element)).toBe(false);
	});

	it("lets the explicit latest action restore output following", () => {
		const { element, controller } = ready(); controller.pause(element);
		element.scrollTop = 200; controller.scrolled(element); element.scrollTo.mockClear();
		controller.resume(element);
		expect(element.scrollTop).toBe(600);
		expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_200, behavior: "instant" });
		expect(controller.followNewContent).toBe(true);
		element.scrollHeight += 50; controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(650);
	});

	it("preserves a user's reading intent even if it arrives before first history finishes loading", () => {
		const element = viewport(250); const controller = new ChatScrollController();
		controller.pause(element); element.scrollTo.mockClear();
		controller.contentChanged(element, true); controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(250);
		expect(controller.followNewContent).toBe(false);
		expect(element.scrollTo).not.toHaveBeenCalled();
	});

	it("retains a paused pagination anchor and ignores its programmatic offset update", () => {
		const { element, controller } = ready(); controller.pause(element);
		element.scrollTop = 80; controller.scrolled(element);
		element.scrollHeight += 500; element.scrollTop += 500; controller.rememberPosition(element);
		controller.scrolled(element); element.scrollTo.mockClear();
		controller.contentChanged(element, false);
		expect(element.scrollTop).toBe(580);
		expect(controller.followNewContent).toBe(false);
		expect(element.scrollTo).not.toHaveBeenCalled();
	});

	it("starts a new Session independently from a paused previous Session", () => {
		const { element, controller: previous } = ready(); previous.pause(element);
		element.scrollTop = 100; previous.scrolled(element);
		const current = new ChatScrollController(); current.contentChanged(element, false);
		expect(element.scrollTop).toBe(600);
		expect(current.followNewContent).toBe(true);
		expect(previous.followNewContent).toBe(false);
	});
});

function historyViewport() {
	let prepended = 0;
	const viewport = {
		scrollTop: 300, scrollHeight: 1_200,
		getBoundingClientRect: () => ({ top: 100 }),
		querySelector: () => ({ children: [above, visible, tail] }),
		contains: (element: unknown) => element === above || element === visible || element === tail,
	};
	const row = (top: number, height: number) => ({ getAttribute: () => null, getBoundingClientRect: () => ({ top: 100 + top + prepended - viewport.scrollTop, bottom: 100 + top + height + prepended - viewport.scrollTop }) });
	const above = row(0, 100); const visible = row(250, 200); const tail = row(900, 100);
	return { viewport, visible, prepend: (height: number) => { prepended += height; } };
}

describe("history pagination scroll anchor", () => {
	it("anchors the first visible existing row and ignores newly growing live content below it", () => {
		const value = historyViewport(); const element = value.viewport as unknown as HTMLElement;
		const anchor = captureChatScrollAnchor(element);
		expect(anchor).toEqual({ element: value.visible, offset: -50 });
		if (!anchor) throw new Error("Expected a visible history row");
		restoreChatScrollAnchor(element, anchor);
		expect(element.scrollTop).toBe(300);
		// Tail growth does not alter the existing row's geometry and must not enter restoration math.
		value.viewport.scrollHeight += 300;
		restoreChatScrollAnchor(element, anchor);
		expect(element.scrollTop).toBe(300);
	});

	it("compensates only the prepend offset and stays stable on later rendering updates", () => {
		const value = historyViewport(); const element = value.viewport as unknown as HTMLElement;
		const anchor = captureChatScrollAnchor(element);
		if (!anchor) throw new Error("Expected a visible history row");
		value.prepend(200); restoreChatScrollAnchor(element, anchor);
		expect(element.scrollTop).toBe(500);
		restoreChatScrollAnchor(element, anchor);
		expect(element.scrollTop).toBe(500);
	});

	it("does not adjust the viewport when the captured row has disappeared", () => {
		const value = historyViewport(); const element = value.viewport as unknown as HTMLElement;
		const anchor = captureChatScrollAnchor(element);
		if (!anchor) throw new Error("Expected a visible history row");
		value.prepend(200); value.viewport.contains = () => false;
		restoreChatScrollAnchor(element, anchor);
		expect(element.scrollTop).toBe(300);
	});

	it("returns no anchor before the timeline is mounted", () => {
		const element = { getBoundingClientRect: () => ({ top: 100 }), querySelector: () => null } as unknown as HTMLElement;
		expect(captureChatScrollAnchor(element)).toBeNull();
	});

	it("skips a visible loading status row and anchors the first message instead", () => {
		const loading = { getAttribute: (name: string) => name === "role" ? "status" : null, getBoundingClientRect: () => ({ top: 100, bottom: 140 }) };
		const message = { getAttribute: () => null, getBoundingClientRect: () => ({ top: 140, bottom: 300 }) };
		const element = { getBoundingClientRect: () => ({ top: 100 }), querySelector: () => ({ children: [loading, message] }) } as unknown as HTMLElement;
		expect(captureChatScrollAnchor(element)).toEqual({ element: message, offset: 40 });
	});
});
