import type { KeyboardEvent, TouchEvent, WheelEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookDriver } from "./helpers/hook-driver";

let hooks: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useRef: (initial: unknown) => hooks.ref(initial),
	useState: (initial: unknown) => hooks.state(initial),
	useMemo: <T,>(factory: () => T, deps?: readonly unknown[]) => hooks.memo(factory, deps),
	useCallback: <T,>(callback: T, deps?: readonly unknown[]) => hooks.memo(() => callback, deps),
	useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => hooks.effect(effect, deps),
}));
import { useChatScroll } from "../features/chat/runtime/use-chat-scroll";

class KeyTarget {
	editable: boolean;
	constructor(editable = false) { this.editable = editable; }
	closest() { return this.editable ? this : null; }
}

interface HistoryRow { getAttribute(name: string): string | null; getBoundingClientRect(): { top: number; bottom: number }; }

function viewport() {
	let position = 0;
	const element = {
		scrollHeight: 1_200, clientHeight: 600,
		get scrollTop() { return position; },
		set scrollTop(value: number) { position = Math.max(0, Math.min(value, element.scrollHeight - element.clientHeight)); },
		scrollTo: vi.fn((options: ScrollToOptions) => { element.scrollTop = options.top ?? element.scrollTop; }),
		getBoundingClientRect: () => ({ top: 100 }),
		rows: [] as HistoryRow[],
		querySelector: (): { children: HistoryRow[] } | null => element.rows.length ? { children: element.rows } : null,
		contains: (row: HistoryRow): boolean => element.rows.includes(row),
	};
	return element;
}

type Options = Parameters<typeof useChatScroll>[0];
function fixture(overrides: Partial<Options> = {}) {
	const options: Options = { sessionId: "first", loading: false, timeline: [], showActivity: false, ...overrides };
	const element = viewport();
	const render = (changes: Partial<Options> = {}) => {
		Object.assign(options, changes);
		return hooks.render(() => {
			const binding = useChatScroll(options);
			binding.scrollRef.current = options.present === false ? null : element as unknown as HTMLDivElement;
			return binding;
		});
	};
	return { element, options, render, binding: render() };
}

function wheel(deltaY: number, overrides: Partial<WheelEvent<HTMLDivElement>> = {}) {
	return { deltaY, deltaX: 0, ctrlKey: false, preventDefault: vi.fn(), ...overrides } as WheelEvent<HTMLDivElement>;
}
function touches(...positions: number[]): TouchList {
	const values = positions.map((clientY) => ({ clientY } as Touch));
	return Object.assign(values, { item: (index: number) => values[index] ?? null });
}
function touch(...positions: number[]) { return { touches: touches(...positions), preventDefault: vi.fn() } as unknown as TouchEvent<HTMLDivElement>; }
function key(value: string, overrides: Partial<KeyboardEvent<HTMLDivElement>> = {}) {
	return { key: value, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false,
		nativeEvent: { isComposing: false }, target: new KeyTarget(), preventDefault: vi.fn(), ...overrides } as unknown as KeyboardEvent<HTMLDivElement>;
}

function history(value: ReturnType<typeof fixture>) {
	let prependHeight = 0;
	const row = (top: number, height: number): HistoryRow => ({ getAttribute: () => null,
		getBoundingClientRect: () => ({ top: 100 + top + prependHeight - value.element.scrollTop,
			bottom: 100 + top + height + prependHeight - value.element.scrollTop }) });
	value.element.rows.push(row(250, 300), row(900, 100));
	return { prepend: (height: number) => { prependHeight += height; value.element.scrollHeight += height; } };
}

beforeEach(() => { hooks = new HookDriver(); vi.stubGlobal("Element", KeyTarget); });
afterEach(() => { hooks.unmount(); vi.unstubAllGlobals(); });

describe("chat viewport user input priority", () => {
	it("pauses on wheel-up before the native scroll event or the next rendering update", () => {
		const value = fixture(); value.element.scrollTo.mockClear(); const event = wheel(-1);
		value.binding.handleWheel(event);
		expect(value.element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: "instant" });
		value.element.scrollHeight += 40;
		expect(value.render({ timeline: [] }).showReturnToBottom).toBe(true);
		expect(value.element.scrollTop).toBe(600);
		expect(value.element.scrollTo).toHaveBeenCalledOnce();
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it.each([wheel(1), wheel(0), wheel(-1, { deltaX: 10 }), wheel(-1, { ctrlKey: true })])("preserves following for downwards, horizontal, or zoom wheel input", (event) => {
		const value = fixture(); value.binding.handleWheel(event);
		value.element.scrollHeight += 10; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(610);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("keeps the chat still while a user reads nested code with an upward wheel gesture", () => {
		const value = fixture(); const event = wheel(-30, { target: new KeyTarget() as unknown as EventTarget });
		value.binding.handleWheel(event); value.element.scrollHeight += 100; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(600);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("treats a downward finger movement as reading older messages without intercepting native touch", () => {
		const value = fixture(); value.binding.handleTouchStart(touch(100)); const event = touch(105);
		value.binding.handleTouchMove(event); value.element.scrollHeight += 100;
		expect(value.render({ timeline: [] }).showReturnToBottom).toBe(true);
		expect(value.element.scrollTop).toBe(600);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("does not pause for downward content scrolling, pinch gestures, or a finished touch", () => {
		const value = fixture();
		value.binding.handleTouchStart(touch(100)); value.binding.handleTouchMove(touch(90));
		value.binding.handleTouchStart(touch(100, 150)); value.binding.handleTouchMove(touch(120, 160));
		value.binding.handleTouchStart(touch(100)); value.binding.handleTouchEnd(); value.binding.handleTouchMove(touch(120));
		value.element.scrollHeight += 10; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(610);
	});

	it.each([key("ArrowUp"), key("PageUp"), key("Home"), key(" ", { shiftKey: true })])("pauses before a native keyboard action reads earlier messages: $key", (event) => {
		const value = fixture(); value.binding.handleKeyDown(event);
		value.element.scrollHeight += 30; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(600);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it.each([
		key("ArrowUp", { target: new KeyTarget(true) as unknown as EventTarget }),
		key("ArrowUp", { defaultPrevented: true }), key("ArrowUp", { ctrlKey: true }),
		key("ArrowUp", { metaKey: true }), key("ArrowUp", { altKey: true }),
		key("ArrowUp", { nativeEvent: { isComposing: true } } as Partial<KeyboardEvent<HTMLDivElement>>),
		key("ArrowDown"), key("PageDown"), key("End"), key(" "),
	])("keeps text editing, handled keys, IME, and downward keys independent from output following", (event) => {
		const value = fixture(); value.binding.handleKeyDown(event);
		value.element.scrollHeight += 15; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(615);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("recognizes direct scrollbar movement and resumes only when the user reaches the bottom", () => {
		const value = fixture(); value.element.scrollTop = 590; value.binding.handleScroll();
		value.element.scrollTo.mockClear(); value.element.scrollHeight += 50; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(590);
		expect(value.element.scrollTo).not.toHaveBeenCalled();
		value.element.scrollTop = 649; value.binding.handleScroll();
		value.element.scrollHeight += 20;
		expect(value.render({ timeline: [] }).showReturnToBottom).toBe(false);
		expect(value.element.scrollTop).toBe(670);
	});

	it("does not resume from the same-position scroll event after pausing at the bottom", () => {
		const value = fixture(); value.binding.handleWheel(wheel(-1)); value.binding.handleScroll();
		value.element.scrollHeight += 50; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(600);
		value.binding.scrollToBottom();
		expect(value.element.scrollTop).toBe(650);
		value.element.scrollHeight += 20;
		expect(value.render({ timeline: [] }).showReturnToBottom).toBe(false);
		expect(value.element.scrollTop).toBe(670);
	});

	it("preserves an upward gesture made while initial history is still loading", () => {
		const value = fixture({ loading: true }); value.element.scrollTop = 200;
		value.binding.handleWheel(wheel(-2)); value.element.scrollTo.mockClear();
		value.render({ loading: false, timeline: [] });
		expect(value.element.scrollTop).toBe(200);
		expect(value.element.scrollTo).not.toHaveBeenCalled();
	});

	it("gives a new Session its own following state and clears the old return button", () => {
		const value = fixture(); value.binding.handleWheel(wheel(-1)); value.element.scrollTop = 250; value.binding.handleScroll();
		expect(value.render().showReturnToBottom).toBe(true);
		expect(value.render({ sessionId: "second", timeline: [] }).showReturnToBottom).toBe(false);
		expect(value.element.scrollTop).toBe(600);
		value.element.scrollHeight += 20; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(620);
	});

	it("holds a pending history row steady while the live tail grows, then compensates only prepended history", () => {
		const value = fixture(); const rows = history(value);
		value.binding.handleWheel(wheel(-1)); value.element.scrollTop = 300; value.binding.handleScroll();
		value.binding.preserveHistoryPosition();
		value.element.scrollHeight += 100; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(300);
		rows.prepend(200); value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(500);
		value.element.scrollHeight += 50; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(500);
		expect(value.render().showReturnToBottom).toBe(true);
	});

	it("updates a pending history anchor when the user continues reading before the request finishes", () => {
		const value = fixture(); const rows = history(value);
		value.binding.handleWheel(wheel(-1)); value.element.scrollTop = 300; value.binding.handleScroll();
		value.binding.preserveHistoryPosition();
		value.element.scrollTop = 400; value.binding.handleScroll();
		value.element.scrollHeight += 100; value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(400);
		rows.prepend(200); value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(600);
	});

	it("does not restore a pending old Session anchor while the new Session is loading", () => {
		const value = fixture(); const rows = history(value);
		value.binding.handleWheel(wheel(-1)); value.element.scrollTop = 300; value.binding.handleScroll();
		value.binding.preserveHistoryPosition(); rows.prepend(200);
		value.render({ sessionId: "second", loading: true, timeline: [] });
		expect(value.element.scrollTop).toBe(300);
		value.render({ loading: false, timeline: [] });
		expect(value.element.scrollTop).toBe(800);
		expect(value.render().showReturnToBottom).toBe(false);
	});

	it("follows initial content when the viewport mounts later without timeline or loading changes", () => {
		const value = fixture({ present: false });
		expect(value.element.scrollTo).not.toHaveBeenCalled();
		value.render({ present: true });
		expect(value.element.scrollTop).toBe(600);
		expect(value.element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_200, behavior: "instant" });
	});

	it("keeps following when a new Session's loading spinner clamps the old loaded viewport", () => {
		const value = fixture(); value.render({ sessionId: "second" });
		value.element.scrollHeight = 100; value.element.scrollTop = 0;
		const loading = value.render({ loading: true }); loading.handleScroll();
		value.element.scrollHeight = 1_200;
		value.render({ loading: false });
		expect(value.element.scrollTop).toBe(600);
		expect(value.render().showReturnToBottom).toBe(false);
	});

	it("still honors explicit upward input during the new Session's loading spinner", () => {
		const value = fixture(); value.render({ sessionId: "second" });
		value.element.scrollHeight = 100; value.element.scrollTop = 0;
		const loading = value.render({ loading: true }); loading.handleScroll(); loading.handleWheel(wheel(-1));
		loading.handleScroll(); value.element.scrollTo.mockClear();
		value.element.scrollHeight = 1_200; value.render({ loading: false });
		expect(value.element.scrollTop).toBe(0);
		expect(value.element.scrollTo).not.toHaveBeenCalled();
		expect(value.render().showReturnToBottom).toBe(true);
	});

	it("compensates an empty or failed pagination status before releasing its anchor without a timeline change", () => {
		const value = fixture(); const rows = history(value);
		value.binding.handleWheel(wheel(-1)); value.element.scrollTop = 300; value.binding.handleScroll();
		value.binding.preserveHistoryPosition();
		const status: HistoryRow = { getAttribute: (name) => name === "role" ? "status" : null,
			getBoundingClientRect: () => ({ top: 100, bottom: 132 }) };
		rows.prepend(32); value.element.rows.unshift(status);
		value.render({ loadingOlderMessages: true });
		expect(value.element.scrollTop).toBe(332);
		rows.prepend(-32); value.element.rows.shift();
		value.render({ loadingOlderMessages: false });
		expect(value.element.scrollTop).toBe(300);
		// The request owner releases the anchor after the indicator removal layout has settled.
		value.render().clearHistoryPosition();
		rows.prepend(25); value.render({ timeline: [] });
		expect(value.element.scrollTop).toBe(300);
	});
});
