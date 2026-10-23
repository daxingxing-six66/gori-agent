import { Children, isValidElement, type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let host: ComponentHost;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useRef: (initial: unknown) => host.ref(initial),
	useState: (initial: unknown) => host.state(initial),
	useEffect: (effect: () => void, deps: readonly unknown[]) => host.effect(effect, deps),
	useImperativeHandle: () => {},
}));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => id }) }));
vi.mock("../features/i18n/components/use-localized-error-message", () => ({ useLocalizedErrorMessage: () => String }));
vi.mock("../features/chat/runtime/use-local-file-search", () => ({ useLocalFileSearch: () => ({
	loading: false, entries: [], error: null, incomplete: false, truncated: false,
}) }));
import { ChatTokenEditor } from "../features/chat/components/chat-token-editor";

/** Executes the component's real handlers without mounting unrelated UI or making network requests. */
class ComponentHost {
	private values: unknown[] = [];
	private cursor = 0;
	private pending: (() => void)[] = [];
	render<T>(render: () => T): T { this.cursor = 0; return render(); }
	ref<T>(initial: T): { current: T } {
		const index = this.cursor++;
		if (!(index in this.values)) this.values[index] = { current: initial };
		return this.values[index] as { current: T };
	}
	state<T>(initial: T): [T, (next: T | ((value: T) => T)) => void] {
		const index = this.cursor++;
		if (!(index in this.values)) this.values[index] = initial;
		return [this.values[index] as T, (next) => {
			this.values[index] = typeof next === "function" ? (next as (value: T) => T)(this.values[index] as T) : next;
		}];
	}
	effect(effect: () => void, deps: readonly unknown[]): void {
		const index = this.cursor++;
		const previous = this.values[index] as readonly unknown[] | undefined;
		if (previous?.length === deps.length && deps.every((value, offset) => Object.is(value, previous[offset]))) return;
		this.values[index] = deps;
		this.pending.push(effect);
	}
	commit(): void { const pending = this.pending; this.pending = []; pending.forEach((effect) => effect()); }
}

interface EditorText { nodeType: number; textContent: string }
class EditorElement {
	childNodes: EditorText[] = [];
	focus = vi.fn();
	normalize = vi.fn();
	setText(text: string): void { this.childNodes = text ? [{ nodeType: 3, textContent: text }] : []; }
	contains(node: unknown): boolean { return node === this || this.childNodes.includes(node as typeof this.childNodes[number]); }
	replaceChildren(fragment: { nodes: EditorText[] }): void { this.childNodes = fragment.nodes; }
}

type EditorProps = ComponentProps<typeof ChatTokenEditor>;
type EditorNode = ReactElement<ComponentProps<"div">>;
const component = ChatTokenEditor as unknown as { render(props: EditorProps, ref: null): ReactNode };
function elements(node: ReactNode): EditorNode[] {
	const result: EditorNode[] = [];
	Children.forEach(node, (child) => {
		if (!isValidElement<ComponentProps<"div">>(child)) return;
		result.push(child, ...elements(child.props.children));
	});
	return result;
}
function fixture(overrides: Partial<EditorProps> = {}) {
	const props: EditorProps = { value: "", placeholder: "Message", onChange: vi.fn(), onSubmit: vi.fn(), onNavigateHistory: vi.fn(() => true), ...overrides };
	const editor = new EditorElement();
	const render = () => {
		const view = host.render(() => component.render(props, null));
		const input = elements(view).find((item) => item.props.role === "textbox")!;
		(input.props.ref as { current: unknown }).current = editor;
		return { view, input };
	};
	return { props, editor, render };
}
function key(input: EditorNode, overrides: Partial<KeyboardEvent<HTMLDivElement>> = {}) {
	const event = { key: "ArrowUp", repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
		keyCode: 38, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), ...overrides };
	input.props.onKeyDown?.(event as KeyboardEvent<HTMLDivElement>);
	return event;
}

beforeEach(() => { host = new ComponentHost(); vi.stubGlobal("Node", { TEXT_NODE: 3 }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("composer history recall keyboard interaction", () => {
	it("recalls only an accepted empty-input ArrowUp and leaves a missing history unhandled", () => {
		const value = fixture();
		expect(key(value.render().input).preventDefault).toHaveBeenCalledOnce();
		expect(value.props.onNavigateHistory).toHaveBeenCalledExactlyOnceWith("older");
		expect(value.props.onSubmit).not.toHaveBeenCalled();
		value.props.onNavigateHistory = vi.fn(() => false);
		expect(key(value.render().input).preventDefault).not.toHaveBeenCalled();
	});

	it("delegates consecutive older and newer keys while browsing, including a nonempty multiline value", () => {
		const value = fixture();
		expect(key(value.render().input).preventDefault).toHaveBeenCalledOnce();
		value.props.navigatingHistory = true;
		value.props.value = "Latest message\nwith another line"; value.editor.setText(value.props.value);
		expect(key(value.render().input).preventDefault).toHaveBeenCalledOnce();
		value.props.value = "Earlier message"; value.editor.setText(value.props.value);
		expect(key(value.render().input, { key: "ArrowDown" }).preventDefault).toHaveBeenCalledOnce();
		expect(vi.mocked(value.props.onNavigateHistory!).mock.calls.map(([direction]) => direction)).toEqual(["older", "older", "newer"]);
	});

	it("leaves ArrowDown alone until history browsing has started", () => {
		const value = fixture();
		expect(key(value.render().input, { key: "ArrowDown" }).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it("continues navigating reordered reference attributes while preserving the original history text", () => {
		const original = 'Inspect\u00a0<file type="text/plain" path="/work/notes.txt" name="notes.txt"/> in <folder path="/work/docs" name="docs" />';
		const value = fixture({ value: original, navigatingHistory: true });
		class ReferenceToken {
			nodeType = 1;
			textContent = "";
			dataset: Record<string, string>;
			constructor(dataset: Record<string, string>) { this.dataset = dataset; }
		}
		vi.stubGlobal("HTMLElement", ReferenceToken);
		const file = new ReferenceToken({ chatReference: "file", name: "notes.txt", path: "/work/notes.txt", mimeType: "text/plain" });
		value.editor.childNodes = [
			{ nodeType: 3, textContent: "Inspect\u00a0" }, file, { nodeType: 3, textContent: " in " },
			new ReferenceToken({ chatReference: "folder", name: "docs", path: "/work/docs" }),
		];
		const { input } = value.render();
		expect(key(input).preventDefault).toHaveBeenCalledOnce();
		expect(key(input, { key: "ArrowDown" }).preventDefault).toHaveBeenCalledOnce();
		expect(key(input).preventDefault).toHaveBeenCalledOnce();
		expect(vi.mocked(value.props.onNavigateHistory!).mock.calls.map(([direction]) => direction)).toEqual(["older", "newer", "older"]);
		expect(value.props.value).toBe(original);
		expect(value.props.onChange).not.toHaveBeenCalled();
		file.dataset.path = "/work/changed.txt";
		expect(key(input).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).toHaveBeenCalledTimes(3);
	});

	it.each(["ArrowUp", "ArrowDown"])("does not replace a freshly edited history entry before React synchronizes it: %s", (pressed) => {
		const value = fixture({ value: "Recalled message", navigatingHistory: true });
		value.editor.setText("Recalled message with a new edit");
		expect(key(value.render().input, { key: pressed }).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it("uses onChange to let the parent exit browsing as soon as recalled text is edited", () => {
		const value = fixture({ value: "Recalled message", navigatingHistory: true });
		vi.stubGlobal("window", { getSelection: () => null });
		value.props.onChange = vi.fn((message: string) => { value.props.value = message; value.props.navigatingHistory = false; });
		value.editor.setText("An edited recalled message");
		const { input } = value.render();
		input.props.onInput?.({} as Parameters<NonNullable<typeof input.props.onInput>>[0]);
		expect(value.props.onChange).toHaveBeenCalledExactlyOnceWith("An edited recalled message");
		expect(key(value.render().input).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it.each(["First line\nSecond line", "<folder name=\"project\" path=\"/work\" />"])("preserves existing draft and normal cursor movement: %s", (text) => {
		const value = fixture({ value: text });
		expect(key(value.render().input).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it("accepts cleared editors that retain placeholder whitespace or a newline", () => {
		const value = fixture({ value: " \n" }); value.editor.setText("\n");
		expect(key(value.render().input).preventDefault).toHaveBeenCalledOnce();
		expect(value.props.onNavigateHistory).toHaveBeenCalledOnce();
	});

	it("does not overwrite fresh DOM input before its controlled value renders", () => {
		const value = fixture(); value.editor.setText("Just typed");
		expect(key(value.render().input).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { repeat: true }])("preserves modified and repeating ArrowUp: %j", (modifiers) => {
		const value = fixture();
		expect(key(value.render().input, modifiers).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it("does not recall from a disabled editor", () => {
		const value = fixture({ disabled: true });
		expect(key(value.render().input).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it("leaves IME navigation alone for composition events, native composing, and keyCode 229", () => {
		const value = fixture(); const { input } = value.render();
		input.props.onCompositionStart?.({} as Parameters<NonNullable<typeof input.props.onCompositionStart>>[0]);
		expect(key(input).preventDefault).not.toHaveBeenCalled();
		expect(key(input, { key: "Enter" }).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
		expect(value.props.onSubmit).not.toHaveBeenCalled();
	});

	it.each([{ nativeEvent: { isComposing: true } }, { keyCode: 229 }])("recognizes native IME signals independently: %j", (signal) => {
		const value = fixture();
		expect(key(value.render().input, signal as Partial<KeyboardEvent<HTMLDivElement>>).preventDefault).not.toHaveBeenCalled();
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
	});

	it("gives an open candidate menu priority over recall and yields to native IME", () => {
		const value = fixture({ tools: [
			{ id: "first", icon: "terminal", name: "First", description: "", keywords: [] },
			{ id: "second", icon: "terminal", name: "Second", description: "", keywords: [] },
		] });
		value.editor.setText("/");
		const text = value.editor.childNodes[0]!;
		vi.stubGlobal("window", { getSelection: () => ({ rangeCount: 1, isCollapsed: true, getRangeAt: () => ({ startContainer: text, startOffset: 1 }) }) });
		vi.stubGlobal("document", { createRange: () => ({ selectNodeContents() {}, setEnd() {}, setStart() {}, toString: () => "/" }) });
		const first = value.render().input;
		first.props.onInput?.({} as Parameters<NonNullable<typeof first.props.onInput>>[0]);
		value.editor.setText("");
		let view = value.render();
		expect(key(view.input).preventDefault).toHaveBeenCalledOnce();
		view = value.render();
		expect(elements(view.view).filter((item) => item.props.role === "option").map((item) => item.props["aria-selected"])).toEqual([false, true]);
		expect(value.props.onNavigateHistory).not.toHaveBeenCalled();
		expect(key(view.input, { nativeEvent: { isComposing: true } } as Partial<KeyboardEvent<HTMLDivElement>>).preventDefault).not.toHaveBeenCalled();
	});

	it("places the caret at the end of an externally restored value only while focused", () => {
		const value = fixture();
		const range = { selectNodeContents: vi.fn(), collapse: vi.fn() };
		const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
		const document = {
			activeElement: value.editor,
			createRange: () => range,
			createDocumentFragment: () => ({ nodes: [] as unknown[], append(node: unknown) { this.nodes.push(node); } }),
			createTextNode: (textContent: string) => ({ nodeType: 3, textContent }),
		};
		vi.stubGlobal("document", document); vi.stubGlobal("window", { getSelection: () => selection });
		value.render(); host.commit();
		selection.addRange.mockClear(); range.collapse.mockClear();
		value.props.value = "Recalled message\nwith another line";
		value.render(); host.commit();
		expect(value.editor.childNodes[0]?.textContent).toBe(value.props.value);
		expect(range.selectNodeContents).toHaveBeenLastCalledWith(value.editor);
		expect(range.collapse).toHaveBeenCalledExactlyOnceWith(false);
		expect(selection.addRange).toHaveBeenCalledExactlyOnceWith(range);
		document.activeElement = new EditorElement(); selection.addRange.mockClear();
		value.props.value = "Other session draft"; value.render(); host.commit();
		expect(selection.addRange).not.toHaveBeenCalled();
	});
});

/** Minimal editable range/selection behavior used by the real menu handlers below. */
function commandMenuFixture(message: string, caretOffset: number, tool: NonNullable<EditorProps["tools"]>[number], overrides: Partial<EditorProps> = {}) {
	const value = fixture({ value: message, tools: [tool], onToolSelect: vi.fn(), ...overrides });
	value.editor.setText(message);
	value.props.onChange = vi.fn((text: string) => { value.props.value = text; });
	class ReferenceElement {
		nodeType = 1;
		tagName = "SPAN";
		textContent = "";
		dataset: Record<string, string> = {};
		childNodes: EditorText[] = [];
		className = "";
		contentEditable = "false";
		title = "";
	}
	vi.stubGlobal("HTMLElement", ReferenceElement);
	type RangeContainer = EditorText | EditorElement;
	class EditableRange {
		startContainer: RangeContainer = value.editor.childNodes[0]!;
		startOffset = 0;
		endContainer: RangeContainer = this.startContainer;
		endOffset = 0;
		setStart(container: RangeContainer, offset: number) { this.startContainer = container; this.startOffset = offset; }
		setEnd(container: RangeContainer, offset: number) { this.endContainer = container; this.endOffset = offset; }
		selectNodeContents(editor: EditorElement) { this.setStart(editor, 0); this.setEnd(editor, editor.childNodes.length); }
		collapse = vi.fn((atStart: boolean) => {
			if (!atStart && this.endContainer === value.editor) {
				const last = value.editor.childNodes.at(-1)!;
				this.setEnd(last, last.textContent.length);
			}
			if (atStart) this.setEnd(this.startContainer, this.startOffset);
			else this.setStart(this.endContainer, this.endOffset);
		});
		deleteContents() {
			if (this.startContainer !== this.endContainer || this.startContainer instanceof EditorElement) throw new Error("Expected one text trigger range");
			this.startContainer.textContent = this.startContainer.textContent.slice(0, this.startOffset) + this.startContainer.textContent.slice(this.endOffset);
		}
		toString() {
			if (this.startContainer === value.editor) {
				const target = value.editor.childNodes.indexOf(this.endContainer as EditorText);
				return value.editor.childNodes.slice(0, target).map((node) => node.textContent).join("") + (this.endContainer as EditorText).textContent.slice(0, this.endOffset);
			}
			return (this.startContainer as EditorText).textContent.slice(this.startOffset, this.endOffset);
		}
	}
	const ranges: EditableRange[] = [];
	let currentRange = new EditableRange(); currentRange.setStart(value.editor.childNodes[0]!, caretOffset); currentRange.setEnd(value.editor.childNodes[0]!, caretOffset);
	const selection = { rangeCount: 1, isCollapsed: true, getRangeAt: () => currentRange, removeAllRanges: vi.fn(), addRange: vi.fn((range: EditableRange) => { currentRange = range; }) };
	vi.stubGlobal("window", { getSelection: () => selection });
	vi.stubGlobal("document", {
		createRange: () => { const range = new EditableRange(); ranges.push(range); return range; },
		createDocumentFragment: () => ({ nodes: [] as EditorText[], append(node: EditorText) { this.nodes.push(node); } }),
		createTextNode: (textContent: string) => ({ nodeType: 3, textContent }),
		createElement: () => new ReferenceElement(),
	});
	const open = () => {
		const { input } = value.render();
		input.props.onInput?.({} as Parameters<NonNullable<typeof input.props.onInput>>[0]);
		return value.render();
	};
	return { ...value, open, ranges, selection, ReferenceElement };
}

const diagnoseDraftTool = { id: "diagnose", icon: "diagnose", name: "Diagnose", description: "", keywords: ["diag"], draftCommand: "/diagnose" } as const;

describe("editable diagnosis menu command", () => {
	it("uses Enter to prepare a focused draft, then allows a separate Enter to submit the user's completed problem", () => {
		const value = commandMenuFixture("/diag", 5, diagnoseDraftTool);
		expect(key(value.open().input, { key: "Enter" }).preventDefault).toHaveBeenCalledOnce();
		expect(value.props.value).toBe("/diagnose ");
		expect(value.props.onToolSelect).not.toHaveBeenCalled();
		expect(value.props.onSubmit).not.toHaveBeenCalled();
		expect(elements(value.render().view).some((item) => item.props.role === "listbox")).toBe(false);
		expect(value.editor.focus).toHaveBeenCalledOnce();
		expect(value.ranges.some((range) => range.collapse.mock.calls.some(([atStart]) => atStart === false))).toBe(true);
		expect(value.selection.addRange).toHaveBeenCalled();
		key(value.render().input, { key: "Enter", repeat: true });
		expect(value.props.onSubmit).not.toHaveBeenCalled();
		const completed = "/diagnose 请排查接口超时";
		value.editor.setText(completed);
		value.render().input.props.onInput?.({} as Parameters<NonNullable<EditorNode["props"]["onInput"]>>[0]);
		expect(value.props.value).toBe(completed);
		key(value.render().input, { key: "Enter" });
		expect(value.props.onSubmit).toHaveBeenCalledOnce();
	});

	it("uses the mouse mention entry to keep existing text and file references in the editable diagnosis draft", () => {
		const reference = '<file name="app.log" path="/work/app.log" type="text/plain" />';
		const value = commandMenuFixture(`检查 @diag ${reference} 保留后续说明`, 8, diagnoseDraftTool);
		const token = new value.ReferenceElement(); token.textContent = "app.log";
		token.dataset = { chatReference: "file", name: "app.log", path: "/work/app.log", mimeType: "text/plain" };
		const prefix = { nodeType: 3, textContent: "检查 @diag " };
		value.editor.childNodes = [prefix, token, { nodeType: 3, textContent: " 保留后续说明" }];
		const caret = value.selection.getRangeAt(); caret.setStart(prefix, 8); caret.setEnd(prefix, 8);
		const option = elements(value.open().view).find((item) => item.props.role === "option")!;
		const event: Pick<Parameters<NonNullable<typeof option.props.onMouseDown>>[0], "button" | "preventDefault"> = { button: 0, preventDefault: vi.fn() };
		option.props.onMouseDown?.(event as Parameters<NonNullable<typeof option.props.onMouseDown>>[0]);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(value.props.value).toBe(`/diagnose 检查  ${reference} 保留后续说明`);
		expect(value.props.onToolSelect).not.toHaveBeenCalled();
		expect(value.props.onSubmit).not.toHaveBeenCalled();
		expect(value.editor.focus).toHaveBeenCalledOnce();
	});

	it("keeps one diagnosis prefix when the command is selected again from a mention", () => {
		const value = commandMenuFixture("/diagnose 接口超时 @diag", 21, diagnoseDraftTool);
		const actualOffset = value.props.value.length;
		const caret = value.selection.getRangeAt(); caret.setStart(value.editor.childNodes[0]!, actualOffset); caret.setEnd(value.editor.childNodes[0]!, actualOffset);
		key(value.open().input, { key: "Enter" });
		expect(value.props.value).toBe("/diagnose 接口超时 ");
		expect(value.props.onToolSelect).not.toHaveBeenCalled();
		expect(value.props.onSubmit).not.toHaveBeenCalled();
	});

	it("closes the chosen menu even when preserved draft text ends in another mention trigger", () => {
		const value = commandMenuFixture("/diag @config", 5, diagnoseDraftTool);
		key(value.open().input, { key: "Enter" });
		expect(value.props.value).toBe("/diagnose  @config");
		expect(elements(value.render().view).some((item) => item.props.role === "listbox")).toBe(false);
		expect(value.props.onToolSelect).not.toHaveBeenCalled();
		expect(value.props.onSubmit).not.toHaveBeenCalled();
	});

	it.each([{ toolDisabled: true, editorDisabled: false }, { toolDisabled: false, editorDisabled: true }])("does not insert a disabled diagnosis entry: %j", ({ toolDisabled, editorDisabled }) => {
		const value = commandMenuFixture("/diag", 5, { ...diagnoseDraftTool, disabled: toolDisabled }, { disabled: editorDisabled });
		const view = value.open(); key(view.input, { key: "Enter" });
		const option = elements(view.view).find((item) => item.props.role === "option")!;
		const event: Pick<Parameters<NonNullable<typeof option.props.onMouseDown>>[0], "button" | "preventDefault"> = { button: 0, preventDefault: vi.fn() };
		option.props.onMouseDown?.(event as Parameters<NonNullable<typeof option.props.onMouseDown>>[0]);
		expect(value.props.value).toBe("/diag");
		expect(value.props.onChange).not.toHaveBeenCalled();
		expect(value.props.onToolSelect).not.toHaveBeenCalled();
		expect(value.props.onSubmit).not.toHaveBeenCalled();
	});

	it("lets Chinese composition finish before a menu Enter can select the diagnosis draft", () => {
		const value = commandMenuFixture("/diag", 5, diagnoseDraftTool);
		const view = value.open();
		expect(key(view.input, { key: "Enter", nativeEvent: { isComposing: true } } as Partial<KeyboardEvent<HTMLDivElement>>).preventDefault).not.toHaveBeenCalled();
		expect(value.props.value).toBe("/diag");
		expect(value.props.onChange).not.toHaveBeenCalled();
		expect(value.props.onToolSelect).not.toHaveBeenCalled();
		expect(value.props.onSubmit).not.toHaveBeenCalled();
	});

	it("preserves immediate activation for tools without a draft command", () => {
		const value = commandMenuFixture("/term", 5, { id: "terminal", icon: "terminal", name: "Terminal", description: "", keywords: [] });
		key(value.open().input, { key: "Enter" });
		expect(value.props.value).toBe("");
		expect(value.props.onToolSelect).toHaveBeenCalledExactlyOnceWith("terminal");
		expect(value.props.onSubmit).not.toHaveBeenCalled();
	});
});
