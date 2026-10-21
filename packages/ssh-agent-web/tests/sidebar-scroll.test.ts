import type { RefObject, UIEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookDriver } from "./helpers/hook-driver";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useRef: (initial: unknown) => driver.ref(initial),
	useCallback: <T,>(callback: T, deps: readonly unknown[]) => driver.memo(() => callback, deps),
	useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => driver.effect(effect, deps),
}));
import { useSidebarScroll } from "../components/use-sidebar-scroll";

function viewport(selectedTop?: number) {
	const element = {
		scrollTop: 0, clientHeight: 400,
		getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
		querySelector: vi.fn(() => selectedTop === undefined ? null : {
			getBoundingClientRect: () => ({ top: 100 + selectedTop - element.scrollTop, bottom: 132 + selectedTop - element.scrollTop }),
		}),
	} as unknown as HTMLDivElement;
	return element;
}

function mount(position: RefObject<number>, element: HTMLDivElement, ready = true, sessionId?: string) {
	let attached = false;
	const render = (loaded = ready, selected = sessionId) => driver.render(() => {
		const binding = useSidebarScroll(position, loaded, selected);
		if (!attached) { binding.ref(element); attached = true; }
		return binding;
	});
	return { render, binding: render() };
}

function scroll(binding: ReturnType<typeof useSidebarScroll>, element: HTMLDivElement, top: number) {
	element.scrollTop = top;
	binding.onScroll({ currentTarget: element } as UIEvent<HTMLDivElement>);
}

beforeEach(() => { driver = new HookDriver(); });

describe("sidebar scroll across navigation", () => {
	it("keeps a bottom session at the same position when the page remounts", () => {
		const position = { current: 0 };
		const previous = viewport();
		const first = mount(position, previous);
		scroll(first.binding, previous, 720);
		first.binding.ref(null);
		driver = new HookDriver();
		const next = viewport(1000);
		mount(position, next, true, "bottom-session");
		expect(next.scrollTop).toBe(720);
		expect(position.current).toBe(720);
	});

	it.each([{ top: 100, expected: 100 }, { top: 1100, expected: 732 }])("only moves far enough to reveal an off-screen session at $top", ({ top, expected }) => {
		const position = { current: 400 };
		const element = viewport(top);
		mount(position, element, true, "selected");
		expect(element.scrollTop).toBe(expected);
		expect(position.current).toBe(expected);
	});

	it("waits for asynchronously loaded tree data without overwriting the saved position", () => {
		const position = { current: 720 };
		const element = viewport(1000);
		const mounted = mount(position, element, false, "selected");
		mounted.binding.onScroll({ currentTarget: element } as UIEvent<HTMLDivElement>);
		expect(position.current).toBe(720);
		mounted.render(true);
		expect(element.scrollTop).toBe(720);
	});

	it("does not pull the user back to the selected row on tree or activity updates", () => {
		const position = { current: 720 };
		const element = viewport(1000);
		const mounted = mount(position, element, true, "selected");
		scroll(mounted.binding, element, 0);
		mounted.render();
		mounted.render();
		expect(element.scrollTop).toBe(0);
		expect(position.current).toBe(0);
	});

	it("preserves the position when collapsed and expanded again", () => {
		const position = { current: 720 };
		const element = viewport();
		const mounted = mount(position, element);
		// Capture the actual position even if navigation beats the pending scroll event.
		element.scrollTop = 740;
		mounted.binding.ref(null);
		const next = viewport();
		mounted.binding.ref(next);
		mounted.render();
		expect(next.scrollTop).toBe(740);
	});

	it("waits for a hidden mobile drawer to open and ignores its zero-sized viewport", () => {
		const position = { current: 720 };
		const element = viewport(1000);
		Object.defineProperty(element, "clientHeight", { value: 0, writable: true });
		const mounted = mount(position, element, true, "selected");
		expect(position.current).toBe(720);
		Object.defineProperty(element, "clientHeight", { value: 400 });
		mounted.render();
		expect(element.scrollTop).toBe(720);
	});

	it("locates a changed selection while keeping the same sidebar mounted", () => {
		const position = { current: 720 };
		const element = viewport(1000);
		const mounted = mount(position, element, true, "first");
		scroll(mounted.binding, element, 0);
		mounted.render(true, "second");
		expect(element.scrollTop).toBe(632);
	});
});
