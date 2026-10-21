import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderFile } from "../features/file-reader/api/file-reader-api";
import type { ReaderSource } from "../features/file-reader/model/reader-file";
import type { SessionAttachment } from "../features/session/api/session-attachment-api";

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
vi.mock("../features/file-reader/api/file-reader-api", () => ({ fileReaderApi: { read: vi.fn(), readAttachment: vi.fn() } }));

import { fileReaderApi } from "../features/file-reader/api/file-reader-api";
import { useFileReaderTabs } from "../features/file-reader/runtime/use-file-reader-tabs";
import { useReaderFile } from "../features/file-reader/runtime/use-reader-file";
import { ChatMessageRow } from "../features/chat/components/chat-message";
import { ChatTimeline } from "../features/chat/components/chat-timeline";

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
function local(path: string): ReaderSource { return { kind: "local", path }; }
function attachment(id = "attachment-a", sessionId = "a"): SessionAttachment {
	return { id, sessionId, name: "README.md", mimeType: "text/markdown", size: 20,
		storagePath: "/must-not-read-this/client-path", contentUrl: "/must-not-fetch-this/content", createdAt: 1 };
}

beforeEach(() => { driver = new HookDriver(); vi.mocked(fileReaderApi.read).mockReset(); vi.mocked(fileReaderApi.readAttachment).mockReset(); });

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
	it("opens attachment identities once while keeping different IDs and local files independent", () => {
		const render = () => driver.render(() => useFileReaderTabs("a", "/work"));
		const first = render().openAttachment(attachment());
		render().openAttachment(attachment());
		render().openAttachment(attachment("attachment-b"));
		render().open("README.md");
		expect(render().documents).toHaveLength(3);
		expect(render().documents[0]).toMatchObject({ id: first, revision: 1, source: { kind: "attachment", attachmentId: "attachment-a" } });
		expect(render().openAttachment(attachment("other", "b"))).toBeNull();
		expect(render().documents).toHaveLength(3);
		expect(driver.render(() => useFileReaderTabs("b", "/work")).documents).toEqual([]);
	});
	it("aborts superseded reads and discards late responses even if fetch ignores abort", async () => {
		const first = deferred<ReaderFile>(), second = deferred<ReaderFile>();
		vi.mocked(fileReaderApi.read).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		driver.render(() => useReaderFile("a", local("a.ts"), 0));
		const signal = vi.mocked(fileReaderApi.read).mock.calls[0]![2];
		driver.render(() => useReaderFile("a", local("a.ts"), 1));
		expect(signal.aborted).toBe(true);
		second.resolve(file("new")); await second.promise;
		first.resolve(file("stale")); await first.promise;
		expect(driver.render(() => useReaderFile("a", local("a.ts"), 1)).file?.path).toBe("new");
		driver.unmount();
		expect(vi.mocked(fileReaderApi.read).mock.calls[1]![2].aborted).toBe(true);
	});
	it("shows errors and retries without opening any other feature", async () => {
		const first = deferred<ReaderFile>(), retry = deferred<ReaderFile>();
		vi.mocked(fileReaderApi.read).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
		driver.render(() => useReaderFile("a", local("a.md"), 0));
		first.reject(new Error("Not found")); await first.promise.catch(() => {});
		const failed = driver.render(() => useReaderFile("a", local("a.md"), 0));
		expect(failed).toMatchObject({ loading: false, error: new Error("Not found") });
		failed.refresh(); driver.render(() => useReaderFile("a", local("a.md"), 0));
		retry.resolve(file("a.md")); await retry.promise;
		expect(driver.render(() => useReaderFile("a", local("a.md"), 0))).toMatchObject({ loading: false, error: null, file: { path: "a.md" } });
	});
	it("reads attachments by Session and ID, refreshes and aborts on close", async () => {
		const first = deferred<ReaderFile>(), retry = deferred<ReaderFile>();
		vi.mocked(fileReaderApi.readAttachment).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
		const source: ReaderSource = { kind: "attachment", attachmentId: "attachment-a" };
		const render = () => driver.render(() => useReaderFile("a", source, 0));
		render();
		expect(fileReaderApi.read).not.toHaveBeenCalled();
		expect(fileReaderApi.readAttachment).toHaveBeenCalledWith("a", "attachment-a", expect.any(AbortSignal));
		first.reject(new Error("Too large")); await first.promise.catch(() => {});
		expect(render().error).toEqual(new Error("Too large"));
		render().refresh(); render();
		expect(vi.mocked(fileReaderApi.readAttachment).mock.calls[0]![2].aborted).toBe(true);
		retry.resolve(file("README.md")); await retry.promise;
		expect(render().file?.path).toBe("README.md");
		driver.unmount();
		expect(vi.mocked(fileReaderApi.readAttachment).mock.calls[1]![2].aborted).toBe(true);
	});
	it("hides previous attachment contents immediately after a Session change and ignores its late reply", async () => {
		const old = deferred<ReaderFile>(), reload = deferred<ReaderFile>(), next = deferred<ReaderFile>();
		vi.mocked(fileReaderApi.readAttachment).mockReturnValueOnce(old.promise).mockReturnValueOnce(reload.promise).mockReturnValueOnce(next.promise);
		const source: ReaderSource = { kind: "attachment", attachmentId: "shared-id" };
		driver.render(() => useReaderFile("a", source, 0));
		old.resolve(file("old-session-secret")); await old.promise;
		expect(driver.render(() => useReaderFile("a", source, 0)).file?.path).toBe("old-session-secret");
		driver.render(() => useReaderFile("a", source, 1));
		const changed = driver.render(() => useReaderFile("b", source, 0));
		expect(changed.file).toBeNull();
		reload.resolve(file("late-old-session-secret")); await reload.promise;
		expect(driver.render(() => useReaderFile("b", source, 0)).file).toBeNull();
		next.resolve(file("new-session-file")); await next.promise;
		expect(driver.render(() => useReaderFile("b", source, 0)).file?.path).toBe("new-session-file");
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

describe("document attachment reader entry", () => {
	it("passes the scoped document through history while preserving the image preview entry", () => {
		const document = attachment();
		const image: SessionAttachment = { ...attachment("image"), name: "screenshot.png", mimeType: "image/png" };
		const onOpenAttachment = vi.fn();
		const controls = expand(<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false}
			timeline={[{ key: "user-message", final: true, message: { role: "user", content: "Read these", timestamp: 1 }, attachments: [document, image] }]}
			tools={{}} approvals={{}} approvalMutationId={null} run={null} latestUserText="Read these"
			onResolveApproval={vi.fn()} onRestoreDraft={vi.fn()} onOpenAttachment={onOpenAttachment} />);
		const documentControl = controls.find((button) => button.props["aria-label"] === "chat.attachment.document.open");
		expect(documentControl).toBeDefined();
		expect(documentControl?.props.disabled).toBe(false);
		documentControl?.props.onClick?.({} as Parameters<NonNullable<ComponentProps<"button">["onClick"]>>[0]);
		expect(onOpenAttachment).toHaveBeenCalledExactlyOnceWith(document);
		expect(controls.some((button) => button.props["aria-label"] === "chat.attachment.preview")).toBe(true);
		expect(fileReaderApi.read).not.toHaveBeenCalled();
		expect(fileReaderApi.readAttachment).not.toHaveBeenCalled();
	});
});
