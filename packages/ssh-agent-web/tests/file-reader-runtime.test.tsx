import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderFile } from "../features/file-reader/api/file-reader-api";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => driver.state(initial),
	useMemo: (factory: () => unknown, deps: readonly unknown[]) => driver.memo(factory, deps),
	useCallback: <T,>(callback: T) => callback,
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
	useId: () => "reader-test",
	memo: <T,>(component: T) => component,
}));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => id }) }));
vi.mock("../features/file-reader/api/file-reader-api", () => ({ fileReaderApi: { read: vi.fn() } }));

import { fileReaderApi } from "../features/file-reader/api/file-reader-api";
import { useFileReaderTabs } from "../features/file-reader/runtime/use-file-reader-tabs";
import { useReaderFile } from "../features/file-reader/runtime/use-reader-file";
import { ChatMessageRow } from "../features/chat/components/chat-message";

class HookDriver {
	private values: unknown[] = [];
	private memos: { value: unknown; deps: readonly unknown[] }[] = [];
	private effects: { deps: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
	private stateIndex = 0;
	private memoIndex = 0;
	private effectIndex = 0;
	state<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
		const index = this.stateIndex++;
		if (!(index in this.values)) this.values[index] = initial;
		return [this.values[index] as T, (next) => { this.values[index] = typeof next === "function" ? (next as (current: T) => T)(this.values[index] as T) : next; }];
	}
	memo<T>(factory: () => T, deps: readonly unknown[]): T {
		const index = this.memoIndex++;
		if (!equal(this.memos[index]?.deps, deps)) this.memos[index] = { value: factory(), deps };
		return this.memos[index]!.value as T;
	}
	effect(effect: () => void | (() => void), deps: readonly unknown[]) {
		const index = this.effectIndex++;
		if (equal(this.effects[index]?.deps, deps)) return;
		this.effects[index]?.cleanup?.();
		this.effects[index] = { deps, cleanup: effect() };
	}
	render<T>(render: () => T): T { this.stateIndex = this.memoIndex = this.effectIndex = 0; return render(); }
	unmount() { this.effects.forEach((effect) => effect.cleanup?.()); }
}
function equal(left: readonly unknown[] | undefined, right: readonly unknown[]) {
	return left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function file(path: string): ReaderFile { return { path, name: path, content: path, size: 1, modifiedAt: 1 }; }

beforeEach(() => { driver = new HookDriver(); vi.mocked(fileReaderApi.read).mockReset(); });

describe("reader lifecycle", () => {
	it("deduplicates paths, reloads existing files and closes only the requested reader", () => {
		const render = () => driver.render(() => useFileReaderTabs("session-a", "/work"));
		const first = render().open("./src/a.ts");
		render().open("/work/src/a.ts");
		const second = render().open("src/b.ts");
		expect(render().documents).toHaveLength(2);
		expect(render().documents[0]).toMatchObject({ id: first, revision: 1 });
		render().close(first);
		expect(render().documents.map((entry) => entry.id)).toEqual([second]);
	});
	it("isolates readers immediately on Session changes", () => {
		driver.render(() => useFileReaderTabs("a", "/work")).open("a.md");
		const next = driver.render(() => useFileReaderTabs("b", "/work"));
		expect(next.documents).toEqual([]);
		next.open("b.md");
		expect(driver.render(() => useFileReaderTabs("b", "/work")).documents.map((entry) => entry.name)).toEqual(["b.md"]);
	});
	it("aborts superseded reads and discards late responses even if fetch ignores abort", async () => {
		const first = deferred<ReaderFile>(), second = deferred<ReaderFile>();
		vi.mocked(fileReaderApi.read).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		driver.render(() => useReaderFile("a", "a.ts", 0));
		const signal = vi.mocked(fileReaderApi.read).mock.calls[0]![2];
		driver.render(() => useReaderFile("a", "a.ts", 1));
		expect(signal.aborted).toBe(true);
		second.resolve(file("new")); await second.promise;
		first.resolve(file("stale")); await first.promise;
		expect(driver.render(() => useReaderFile("a", "a.ts", 1)).file?.path).toBe("new");
		driver.unmount();
		expect(vi.mocked(fileReaderApi.read).mock.calls[1]![2].aborted).toBe(true);
	});
	it("shows errors and retries without opening any other feature", async () => {
		const first = deferred<ReaderFile>(), retry = deferred<ReaderFile>();
		vi.mocked(fileReaderApi.read).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
		driver.render(() => useReaderFile("a", "a.md", 0));
		first.reject(new Error("Not found")); await first.promise.catch(() => {});
		const failed = driver.render(() => useReaderFile("a", "a.md", 0));
		expect(failed).toMatchObject({ loading: false, error: new Error("Not found") });
		failed.refresh(); driver.render(() => useReaderFile("a", "a.md", 0));
		retry.resolve(file("a.md")); await retry.promise;
		expect(driver.render(() => useReaderFile("a", "a.md", 0))).toMatchObject({ loading: false, error: null, file: { path: "a.md" } });
	});
});

function expand(node: ReactNode): ReactElement<ComponentProps<"button">>[] {
	const result: ReactElement<ComponentProps<"button">>[] = [];
	Children.forEach(node, (child) => {
		if (!isValidElement<{ children?: ReactNode }>(child)) return;
		if (typeof child.type === "function") result.push(...expand((child.type as (props: unknown) => ReactNode)(child.props)));
		else {
			if (child.type === "button") result.push(child as ReactElement<ComponentProps<"button">>);
			result.push(...expand(child.props.children));
		}
	});
	return result;
}

describe("file tool reader entry", () => {
	it.each(["read", "write"])("opens the %s file through its callback without toggling details", (name) => {
		const onOpenFile = vi.fn();
		const view = <ChatMessageRow entry={{ key: "message", final: true, message: { role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
			content: [{ type: "toolCall", id: "call", name, arguments: { path: "docs/a.md" } }] } }}
			tools={{ call: { toolCallId: "call", toolName: name, status: "completed" } }} approvals={{}} approvalMutationId={null} onOpenFile={onOpenFile} onResolveApproval={vi.fn()} />;
		const control = expand(view).find((button) => button.props["aria-label"] === "fileReader.open")!;
		expect(control).toBeDefined();
		const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
		control.props.onClick?.(event as unknown as Parameters<NonNullable<ComponentProps<"button">["onClick"]>>[0]);
		expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("docs/a.md");
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(event.stopPropagation).toHaveBeenCalledOnce();
	});
	it.each(["waiting", "running", "failed"] as const)("does not offer an unconfirmed file for a %s tool", (status) => {
		const controls = expand(<ChatMessageRow entry={{ key: "message", final: true, message: { role: "assistant", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
			content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "a.md" } }] } }}
			tools={{ call: { toolCallId: "call", toolName: "write", status } }} approvals={{}} approvalMutationId={null} onOpenFile={vi.fn()} onResolveApproval={vi.fn()} />);
		expect(controls.some((button) => button.props["aria-label"] === "fileReader.open")).toBe(false);
	});
});
