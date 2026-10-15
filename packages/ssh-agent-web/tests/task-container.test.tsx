import { readFileSync } from "node:fs";
import { Children, isValidElement, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskContainer, type TaskTab } from "../features/task-container/components/task-container.tsx";

// The existing Node test environment has no DOM. These two hooks also let us
// inspect native controls and exercise their event handlers with focus spies.
vi.mock("react", async (importOriginal) => ({
	...await importOriginal<typeof import("react")>(),
	useId: () => "task-container-test",
	useRef: (initial: unknown) => ({ current: initial }),
	useEffect: () => undefined,
}));

function elements(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
	const result: ReactElement<{ children?: ReactNode }>[] = [];
	Children.forEach(node, (child) => {
		if (!isValidElement<{ children?: ReactNode }>(child)) return;
		result.push(child, ...elements(child.props.children));
	});
	return result;
}

function buttons(node: ReactNode): ReactElement<ComponentProps<"button">>[] {
	return elements(node).filter((element) => element.type === "button") as ReactElement<ComponentProps<"button">>[];
}

function tabs(): TaskTab[] {
	return [
		{ id: "task-a", title: "Task A", content: <div>First task content</div> },
		{ id: "task-b", title: "Task B", content: <div>Second task content</div> },
		{ id: "task-c", title: "Task C", content: <div>Third task content</div> },
	];
}

describe("task container", () => {
	it("renders generic tabs and keeps every page mounted while showing only the selected one", () => {
		const render = (activeTabId: string) => renderToStaticMarkup(<TaskContainer tabs={tabs()}
			activeTabId={activeTabId} tabListLabel="Open tasks" onSelect={vi.fn()} />);
		for (const active of ["task-a", "task-b"]) {
			const html = render(active);
			expect(html).toContain('role="tablist" aria-label="Open tasks"');
			expect(html.match(/role="tab"/g)).toHaveLength(3);
			expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
			expect(html.match(/hidden=""/g)).toHaveLength(2);
			expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
			expect(html).toContain("First task content");
			expect(html).toContain("Second task content");
			expect(html).toContain("Third task content");
			expect(html).toContain(`aria-controls="task-container-test-${active}-panel" tabindex="0"`);
		}
	});

	it("selects through native buttons without taking ownership of task state", () => {
		const onSelect = vi.fn();
		const view = TaskContainer({ tabs: tabs(), activeTabId: "task-a", tabListLabel: "Open tasks", onSelect });
		const second = buttons(view).find((button) => button.props.id?.endsWith("task-b-tab"))!;
		second.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("task-b");
		expect(second.props["aria-selected"]).toBe(false);
	});

	it.each([
		["ArrowRight", 2, "task-a"], ["ArrowLeft", 0, "task-c"],
		["Home", 1, "task-a"], ["End", 0, "task-c"],
	] as const)("%s selects and focuses the target tab", (key, start, target) => {
		const onSelect = vi.fn();
		const view = TaskContainer({ tabs: tabs(), activeTabId: "task-b", tabListLabel: "Open tasks", onSelect });
		const controls = buttons(view);
		const focus = vi.fn();
		const ref = controls.find((button) => button.props.id?.endsWith(`${target}-tab`))!.props.ref;
		if (typeof ref === "function") ref({ focus } as unknown as HTMLButtonElement);
		const preventDefault = vi.fn();
		controls[start]!.props.onKeyDown?.({ key, preventDefault } as unknown as KeyboardEvent<HTMLButtonElement>);
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(target);
		expect(focus).toHaveBeenCalledOnce();
		expect(preventDefault).toHaveBeenCalledOnce();
	});

	it("leaves ordinary keys and browser shortcuts alone", () => {
		const onSelect = vi.fn();
		const view = TaskContainer({ tabs: tabs(), activeTabId: "task-a", tabListLabel: "Open tasks", onSelect });
		const first = buttons(view)[0]!;
		const preventDefault = vi.fn();
		first.props.onKeyDown?.({ key: "Enter", preventDefault } as unknown as KeyboardEvent<HTMLButtonElement>);
		first.props.onKeyDown?.({ key: "ArrowLeft", altKey: true, preventDefault } as unknown as KeyboardEvent<HTMLButtonElement>);
		expect(onSelect).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it("requests close from an independent button and retains the page until the caller removes it", () => {
		const onRequestClose = vi.fn();
		const task = { ...tabs()[0]!, close: { label: "Close Task A", onRequestClose } };
		const view = TaskContainer({ tabs: [task], activeTabId: task.id, tabListLabel: "Open tasks", onSelect: vi.fn() });
		const controls = buttons(view);
		expect(controls).toHaveLength(2);
		expect(buttons(controls[0]!.props.children)).toHaveLength(0);
		controls[1]!.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
		expect(onRequestClose).toHaveBeenCalledOnce();
		expect(renderToStaticMarkup(view)).toContain("First task content");
	});

	it.each([{ disabled: true }, { busy: true }])("honors caller-provided close restrictions: %j", (restriction) => {
		const onRequestClose = vi.fn();
		const task = { ...tabs()[0]!, close: { label: "Close Task A", disabledReason: "Task operation in progress", ...restriction, onRequestClose } };
		const view = TaskContainer({ tabs: [task], activeTabId: task.id, tabListLabel: "Open tasks", onSelect: vi.fn() });
		const close = buttons(view)[1]!;
		expect(close.props.disabled).toBe(true);
		expect(close.props.title).toBe("Task operation in progress");
		expect(close.props["aria-describedby"]).toBe("task-container-test-task-a-close-reason");
		close.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
		expect(onRequestClose).not.toHaveBeenCalled();
	});

	it("uses presentation status supplied by the caller and has no business dependencies", () => {
		const html = renderToStaticMarkup(<TaskContainer tabs={[{ ...tabs()[0]!, status: { label: "Ready", tone: "positive" } }]}
			activeTabId="task-a" tabListLabel="Open tasks" onSelect={vi.fn()} />);
		expect(html).toContain("task-container-status-positive");
		expect(html).toContain("Ready");
		const source = readFileSync(new URL("../features/task-container/components/task-container.tsx", import.meta.url), "utf8");
		expect(source).not.toMatch(/from ["'][^"']*(?:terminal|deploy|monitor|\/api\/)/i);
	});

	it("provides a selected page when a stale active id is removed and renders nothing without tasks", () => {
		const html = renderToStaticMarkup(<TaskContainer tabs={tabs()} activeTabId="removed-task" tabListLabel="Open tasks" onSelect={vi.fn()} />);
		expect(html).toContain('id="task-container-test-task-a-tab" aria-selected="true"');
		expect(TaskContainer({ tabs: [], activeTabId: null, tabListLabel: "Open tasks", onSelect: vi.fn() })).toBeNull();
	});

	it.each(["docked", "fullscreen", "collapsed"] as const)("retains task pages in %s display mode without requesting business closure", (mode) => {
		const onRequestClose = vi.fn();
		const task = { ...tabs()[0]!, close: { label: "Close Task A", onRequestClose } };
		const html = renderToStaticMarkup(<TaskContainer tabs={[task]} activeTabId={task.id} tabListLabel="Open tasks" onSelect={vi.fn()}
			display={{ mode, fullscreenLabel: "Fullscreen", exitFullscreenLabel: "Restore", collapseLabel: "Collapse", expandLabel: "Expand", onModeChange: vi.fn() }} />);
		expect(html).toContain(`data-display="${mode}"`);
		expect(html).toContain("First task content");
		expect(html).toContain('role="tabpanel"');
		expect(html).toContain(mode === "collapsed" ? 'id="task-container-test-content" hidden=""' : 'id="task-container-test-content"');
		expect(html).not.toContain('aria-modal="true"'); // The server navigation stays usable when enlarged.
		expect(onRequestClose).not.toHaveBeenCalled();
	});

	it.each([
		["docked", "Fullscreen", "fullscreen"], ["fullscreen", "Restore", "docked"],
		["fullscreen", "Collapse", "collapsed"], ["collapsed", "Expand", "docked"],
	] as const)("%s display control %s requests %s without selecting or closing a task", (mode, label, target) => {
		const onModeChange = vi.fn();
		const onSelect = vi.fn();
		const onRequestClose = vi.fn();
		const task = { ...tabs()[0]!, close: { label: "Close Task A", onRequestClose } };
		const view = TaskContainer({ tabs: [task], activeTabId: task.id, tabListLabel: "Open tasks", onSelect,
			display: { mode, fullscreenLabel: "Fullscreen", exitFullscreenLabel: "Restore", collapseLabel: "Collapse", expandLabel: "Expand", onModeChange } });
		buttons(view).find((button) => button.props["aria-label"] === label)!.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
		expect(onModeChange).toHaveBeenCalledExactlyOnceWith(target);
		expect(onSelect).not.toHaveBeenCalled();
		expect(onRequestClose).not.toHaveBeenCalled();
	});
});
