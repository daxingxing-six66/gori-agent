import { isValidElement, type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserDecisionPanel } from "../features/chat/components/user-decision-panel";
import type { UserDecision, UserDecisionAnswer } from "../features/chat/model/user-decision";

class HookHarness {
	#slots: unknown[] = [];
	#cursor = 0;

	beginRender() { this.#cursor = 0; }

	useRef<T>(initial: T): { current: T } {
		const slot = this.#cursor++;
		if (!(slot in this.#slots)) this.#slots[slot] = { current: initial };
		return this.#slots[slot] as { current: T };
	}

	useState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
		const slot = this.#cursor++;
		if (!(slot in this.#slots)) this.#slots[slot] = typeof initial === "function" ? (initial as () => T)() : initial;
		const setValue: Dispatch<SetStateAction<T>> = (action) => {
			const previous = this.#slots[slot] as T;
			this.#slots[slot] = typeof action === "function" ? (action as (value: T) => T)(previous) : action;
		};
		return [this.#slots[slot] as T, setValue];
	}
}

let activeHarness: HookHarness | null = null;
function currentHarness(): HookHarness {
	if (!activeHarness) throw new Error("Decision panel rendered without a test harness");
	return activeHarness;
}

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useId: () => "decision-test",
		useEffect: () => undefined,
		useLayoutEffect: () => undefined,
		useRef: <T>(initial: T) => currentHarness().useRef(initial),
		useState: <T>(initial: T | (() => T)) => currentHarness().useState(initial),
	};
});

vi.mock("react-intl", () => ({
	useIntl: () => ({
		formatMessage: ({ id }: { id: string }, values?: Record<string, number>) => {
			const messages: Record<string, string> = {
				"chat.decision.previous": "上一题",
				"chat.decision.next": "下一题",
				"chat.decision.close": "暂时关闭问题",
				"chat.decision.recommended": "推荐",
				"chat.decision.custom": "或输入你的想法",
				"chat.decision.custom.placeholder": "写下你的想法",
				"chat.decision.custom.hint": "按 Enter 继续",
				"chat.decision.skip": "跳过本题",
				"chat.decision.skipped": "已跳过本题",
				"chat.decision.submit": "提交决定",
				"chat.decision.submitting": "正在提交…",
			};
			if (id === "chat.decision.answered") return `已回答 ${values?.answered} / ${values?.total}`;
			if (id === "chat.decision.position") return `${values?.current} / ${values?.total}`;
			return messages[id] ?? id;
		},
	}),
}));

const decision: UserDecision = {
	id: "decision-1", sessionId: "session-1", runId: "run-1", toolCallId: "call-1",
	status: "pending", createdAt: 1,
	questions: [
		{ question: "第一题？", options: [
			{ label: "第一题选项 A", description: "A 的说明" },
			{ label: "第一题选项 B", description: "B 的说明" },
			{ label: "第一题选项 C", description: "C 的说明" },
		], recommendedIndex: 1 },
		{ question: "第二题？", options: [
			{ label: "第二题选项 A", description: "A 的说明" },
			{ label: "第二题选项 B", description: "B 的说明" },
			{ label: "第二题选项 C", description: "C 的说明" },
		], recommendedIndex: 0 },
		{ question: "第三题？", options: [
			{ label: "第三题选项 A", description: "A 的说明" },
			{ label: "第三题选项 B", description: "B 的说明" },
			{ label: "第三题选项 C", description: "C 的说明" },
		], recommendedIndex: 2 },
	],
};

type TestElement = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): TestElement[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!isValidElement<Record<string, unknown>>(node)) return [];
	return [node, ...elements(node.props.children as ReactNode)];
}

function visibleText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(visibleText).join("");
	return isValidElement<{ children?: ReactNode }>(node) ? visibleText(node.props.children) : "";
}

function findElement(tree: ReactNode, type: string, predicate: (element: TestElement) => boolean = () => true): TestElement | undefined {
	return elements(tree).find((element) => element.type === type && predicate(element));
}

function buttonWithText(tree: ReactNode, text: string): TestElement | undefined {
	return findElement(tree, "button", (button) => visibleText(button.props.children as ReactNode).includes(text));
}

function buttonWithLabel(tree: ReactNode, label: string): TestElement | undefined {
	return findElement(tree, "button", (button) => button.props["aria-label"] === label);
}

function click(button: TestElement | undefined) {
	expect(button).toBeDefined();
	expect(button?.props.disabled).not.toBe(true);
	const handler = button?.props.onClick as (() => void) | undefined;
	expect(handler).toBeTypeOf("function");
	handler?.();
}

function changeText(tree: ReactNode, value: string) {
	const textarea = findElement(tree, "textarea");
	expect(textarea).toBeDefined();
	const handler = textarea?.props.onChange as ((event: { target: { value: string } }) => void) | undefined;
	handler?.({ target: { value } });
}

function pressEnter(tree: ReactNode, options: { shiftKey?: boolean; isComposing?: boolean } = {}) {
	const textarea = findElement(tree, "textarea");
	expect(textarea).toBeDefined();
	const preventDefault = vi.fn();
	const handler = textarea?.props.onKeyDown as ((event: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault(): void }) => void) | undefined;
	handler?.({ key: "Enter", shiftKey: options.shiftKey ?? false, nativeEvent: { isComposing: options.isComposing ?? false }, preventDefault });
	return preventDefault;
}

function setup(input: UserDecision = decision) {
	const hooks = new HookHarness();
	const onSubmit = vi.fn(async (_answers: UserDecisionAnswer[]) => true);
	const onClose = vi.fn();
	const render = (busy = false) => {
		activeHarness = hooks;
		hooks.beginRender();
		return UserDecisionPanel({ decision: input, open: true, busy, error: null, onClose, onSubmit });
	};
	return { render, onSubmit, onClose };
}

beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => {
	activeHarness = null;
	vi.unstubAllGlobals();
});

describe("user decision panel interaction", () => {
	it.each([1, 2, 4, 5])("renders %i options and submits the final option for a single question", (optionCount) => {
		const panel = setup({ ...decision, questions: [{ question: "选一个方案", options: Array.from({ length: optionCount }, (_, index) => ({
			label: `方案 ${index + 1}`, description: `说明 ${index + 1}`,
		})), recommendedIndex: optionCount - 1 }] });
		let tree = panel.render();
		expect(elements(tree).filter((element) => element.type === "button" && String(element.props.className).startsWith("decision-option "))).toHaveLength(optionCount);
		expect(findElement(tree, "span", (element) => element.props.role === "img")?.props["aria-label"]).toBe("推荐");
		click(buttonWithText(tree, `方案 ${optionCount}`));
		tree = panel.render();
		click(buttonWithText(tree, "提交决定"));
		expect(panel.onSubmit).toHaveBeenCalledExactlyOnceWith([{ kind: "option", optionIndex: optionCount - 1 }]);
	});

	it("advances after each option and exposes submit only after answering the final question", () => {
		const panel = setup();
		let tree = panel.render();
		expect(visibleText(findElement(tree, "h2"))).toBe("第一题？");
		expect(buttonWithText(tree, "提交决定")).toBeUndefined();
		expect(buttonWithText(tree, "第一题选项 A")?.props["aria-pressed"]).toBe(false);
		click(buttonWithText(tree, "第一题选项 A"));

		tree = panel.render();
		expect(visibleText(findElement(tree, "h2"))).toBe("第二题？");
		expect(findElement(tree, "div", (element) => element.props.role === "progressbar")?.props["aria-valuenow"]).toBe(1);
		expect(buttonWithText(tree, "提交决定")).toBeUndefined();
		click(buttonWithText(tree, "第二题选项 B"));

		tree = panel.render();
		expect(visibleText(findElement(tree, "h2"))).toBe("第三题？");
		expect(buttonWithText(tree, "提交决定")).toBeUndefined();
		click(buttonWithText(tree, "第三题选项 C"));

		tree = panel.render();
		expect(buttonWithText(tree, "第三题选项 C")?.props["aria-pressed"]).toBe(true);
		expect(findElement(tree, "div", (element) => element.props.role === "progressbar")?.props["aria-valuenow"]).toBe(3);
		click(buttonWithText(tree, "提交决定"));
		expect(panel.onSubmit).toHaveBeenCalledExactlyOnceWith([
			{ kind: "option", optionIndex: 0 },
			{ kind: "option", optionIndex: 1 },
			{ kind: "option", optionIndex: 2 },
		]);
	});

	it("keeps custom input compact until opened and advances only with nonblank text", () => {
		const panel = setup();
		let tree = panel.render();
		expect(findElement(tree, "textarea")).toBeUndefined();
		click(buttonWithText(tree, "或输入你的想法"));
		tree = panel.render();
		expect(findElement(tree, "textarea")?.props["aria-describedby"]).toBe("decision-test-custom-hint");
		expect(findElement(tree, "span", (element) => element.props.id === "decision-test-custom-hint")?.props.className).toBe("sr-only");
		expect(findElement(tree, "textarea")?.props.rows).toBe(1);
		expect(buttonWithText(tree, "或输入你的想法")).toBeUndefined();
		expect(findElement(tree, "textarea")?.props.maxLength).toBe(4_000);
		expect(buttonWithLabel(tree, "下一题")?.props.disabled).toBe(true);
		changeText(tree, "   ");
		tree = panel.render();
		expect(buttonWithLabel(tree, "下一题")?.props.disabled).toBe(true);
		expect(pressEnter(tree)).toHaveBeenCalledOnce();
		expect(visibleText(findElement(panel.render(), "h2"))).toBe("第一题？");

		changeText(tree, "用我的方案");
		tree = panel.render();
		expect(buttonWithLabel(tree, "下一题")?.props.disabled).toBe(false);
		expect(pressEnter(tree, { shiftKey: true })).not.toHaveBeenCalled();
		expect(pressEnter(tree, { isComposing: true })).not.toHaveBeenCalled();
		expect(visibleText(findElement(panel.render(), "h2"))).toBe("第一题？");
		expect(pressEnter(tree)).toHaveBeenCalledOnce();
		tree = panel.render();
		expect(visibleText(findElement(tree, "h2"))).toBe("第二题？");
		expect(buttonWithText(tree, "提交决定")).toBeUndefined();
		click(buttonWithLabel(tree, "上一题"));
		tree = panel.render();
		expect(findElement(tree, "textarea")?.props.value).toBe("用我的方案");

		click(buttonWithLabel(tree, "下一题"));
		tree = panel.render();
		click(buttonWithText(tree, "第二题选项 A"));
		tree = panel.render();
		click(buttonWithText(tree, "或输入你的想法"));
		tree = panel.render();
		changeText(tree, "  ");
		expect(buttonWithText(panel.render(), "提交决定")).toBeUndefined();
		changeText(panel.render(), "第三题由我处理");
		tree = panel.render();
		expect(findElement(tree, "button", (element) => element.props.className === "decision-custom-advance")).toBeUndefined();
		click(buttonWithText(tree, "提交决定"));
		expect(panel.onSubmit).toHaveBeenCalledExactlyOnceWith([
			{ kind: "custom", text: "用我的方案" },
			{ kind: "option", optionIndex: 0 },
			{ kind: "custom", text: "第三题由我处理" },
		]);
	});

	it("treats skipping as a deliberate answer and advances to the next question", () => {
		const panel = setup();
		let tree = panel.render();
		click(buttonWithLabel(tree, "跳过本题"));
		tree = panel.render();
		expect(visibleText(findElement(tree, "h2"))).toBe("第二题？");
		click(buttonWithLabel(tree, "跳过本题"));
		tree = panel.render();
		expect(visibleText(findElement(tree, "h2"))).toBe("第三题？");
		expect(buttonWithText(tree, "提交决定")).toBeUndefined();
		click(buttonWithText(tree, "第三题选项 A"));
		tree = panel.render();
		click(buttonWithText(tree, "提交决定"));
		expect(panel.onSubmit).toHaveBeenCalledExactlyOnceWith([
			{ kind: "skipped" }, { kind: "skipped" }, { kind: "option", optionIndex: 0 },
		]);
	});

	it("provides labeled controls, keyboard dismissal, and disables actions while busy", () => {
		const panel = setup();
		let tree = panel.render();
		const region = findElement(tree, "section");
		expect(region?.props["aria-labelledby"]).toBe("decision-test-title");
		expect(findElement(tree, "h2")?.props.id).toBe("decision-test-title");
		expect(findElement(tree, "span", (element) => element.props.role === "img")?.props["aria-label"]).toBe("推荐");
		expect(buttonWithLabel(tree, "上一题")?.props.disabled).toBe(true);
		expect(buttonWithLabel(tree, "下一题")?.props.disabled).toBe(true);
		const preventDefault = vi.fn();
		const stopPropagation = vi.fn();
		const onKeyDown = region?.props.onKeyDown as ((event: { key: string; preventDefault(): void; stopPropagation(): void }) => void) | undefined;
		onKeyDown?.({ key: "Escape", preventDefault, stopPropagation });
		expect(preventDefault).toHaveBeenCalledOnce();
		expect(stopPropagation).toHaveBeenCalledOnce();
		expect(panel.onClose).toHaveBeenCalledOnce();

		tree = panel.render(true);
		expect(buttonWithText(tree, "第一题选项 A")?.props.disabled).toBe(true);
		expect(buttonWithLabel(tree, "跳过本题")?.props.disabled).toBe(true);
		expect(buttonWithLabel(tree, "暂时关闭问题")?.props.disabled).toBe(true);
		const busyKeyDown = findElement(tree, "section")?.props.onKeyDown as typeof onKeyDown;
		busyKeyDown?.({ key: "Escape", preventDefault, stopPropagation });
		expect(panel.onClose).toHaveBeenCalledOnce();
	});
});
