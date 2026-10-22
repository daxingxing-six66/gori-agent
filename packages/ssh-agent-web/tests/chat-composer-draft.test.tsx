import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookDriver, deferred } from "./helpers/hook-driver";

class DraftHookDriver extends HookDriver {
	readonly notify = vi.fn();
}
let driver: DraftHookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useRef: (initial: unknown) => driver.ref(initial),
	useMemo: (factory: () => unknown, deps: readonly unknown[]) => driver.memo(factory, deps),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
	useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
		const mounted = driver;
		driver.effect(() => subscribe(mounted.notify), [subscribe]);
		return getSnapshot();
	},
	useImperativeHandle: <T,>(ref: Ref<T> | undefined, create: () => T, deps: readonly unknown[]) => driver.effect(() => {
		if (ref && typeof ref !== "function") ref.current = create();
		return () => { if (ref && typeof ref !== "function") ref.current = null; };
	}, [ref, ...deps]),
}));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => id }) }));
vi.mock("../features/chat/runtime/use-chat-attachment-uploads", () => ({ useChatAttachmentUploads: () => ({
	attachments: [], uploads: [], pending: false, limitNotice: false,
	addFiles: vi.fn(), dismiss: vi.fn(), clearSubmitted: vi.fn(),
}) }));
vi.mock("../features/chat/components/chat-token-editor", () => ({ ChatTokenEditor: () => null }));

import { ChatComposerDraftStore, getChatComposerDraftStore } from "../features/chat/runtime/chat-composer-draft-store";
import { useChatComposerDraft } from "../features/chat/runtime/use-chat-composer-draft";
import { ChatComposerPanel, type ChatComposerPanelHandle } from "../features/chat/components/chat-composer-panel";
import { ChatTokenEditor } from "../features/chat/components/chat-token-editor";

let sessionSequence = 0;
let sessionA: string, sessionB: string;
const referencedMessage = "请读取下面的文件\n<file name=\"read me.md\" path=\"/work/read me.md\" type=\"text/markdown\" />\n保留第二行和中文。";
beforeEach(() => {
	driver = new DraftHookDriver();
	sessionA = `draft-test-${++sessionSequence}-a`;
	sessionB = `draft-test-${sessionSequence}-b`;
	vi.stubGlobal("requestAnimationFrame", vi.fn());
});
afterEach(() => { driver.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const hook = (sessionId: string) => driver.render(() => useChatComposerDraft(sessionId));

describe("session composer draft store", () => {
	it("notifies only changed Session snapshots and removes unsubscribed listeners", () => {
		const first = new ChatComposerDraftStore(), second = new ChatComposerDraftStore();
		const firstListener = vi.fn(), secondListener = vi.fn();
		const unsubscribe = first.subscribe(firstListener);
		second.subscribe(secondListener);
		first.set("draft"); first.set("draft");
		expect(firstListener).toHaveBeenCalledOnce();
		expect(secondListener).not.toHaveBeenCalled();
		expect(second.getSnapshot()).toEqual({ text: "", navigatingHistory: false });
		unsubscribe(); first.set("later");
		expect(firstListener).toHaveBeenCalledOnce();
	});

	it("restores rejected submissions without overwriting edits made after submission", () => {
		const store = new ChatComposerDraftStore();
		store.set(referencedMessage);
		const restore = store.clearForSubmission();
		expect(store.getSnapshot()).toEqual({ text: "", navigatingHistory: false });
		restore();
		expect(store.getSnapshot().text).toBe(referencedMessage);
		const staleRestore = store.clearForSubmission();
		store.set("新草稿"); staleRestore();
		expect(store.getSnapshot().text).toBe("新草稿");
	});

	it("does not revive an old submission after later edits are deliberately erased", () => {
		const store = new ChatComposerDraftStore();
		store.set("old message");
		const restore = store.clearForSubmission();
		store.set("new message"); store.set(""); restore();
		expect(store.getSnapshot()).toEqual({ text: "", navigatingHistory: false });
	});
});

describe("Session message history navigation", () => {
	it("moves through the latest seven messages in both directions and stays at the oldest boundary", () => {
		const store = new ChatComposerDraftStore();
		const history = Array.from({ length: 10 }, (_, index) => `message-${index + 1}`);
		for (const text of history.slice(0, 7)) {
			expect(store.navigateHistory("older", history)).toBe(true);
			expect(store.getSnapshot()).toEqual({ text, navigatingHistory: true });
		}
		const oldest = store.getSnapshot();
		expect(store.navigateHistory("older", history)).toBe(true);
		expect(store.getSnapshot()).toBe(oldest);
		for (const text of history.slice(0, 6).reverse()) {
			expect(store.navigateHistory("newer", history)).toBe(true);
			expect(store.getSnapshot()).toEqual({ text, navigatingHistory: true });
		}
		expect(store.navigateHistory("newer", history)).toBe(true);
		expect(store.getSnapshot()).toEqual({ text: "", navigatingHistory: false });
		expect(store.navigateHistory("newer", history)).toBe(false);
	});

	it("preserves a whitespace draft exactly and refuses to replace an unfinished nonblank draft", () => {
		const store = new ChatComposerDraftStore();
		store.set(" \n\t");
		expect(store.navigateHistory("older", [referencedMessage])).toBe(true);
		expect(store.getSnapshot().text).toBe(referencedMessage);
		expect(store.navigateHistory("newer", [referencedMessage])).toBe(true);
		expect(store.getSnapshot()).toEqual({ text: " \n\t", navigatingHistory: false });
		store.set("正在输入");
		expect(store.navigateHistory("older", [referencedMessage])).toBe(false);
		expect(store.getSnapshot()).toEqual({ text: "正在输入", navigatingHistory: false });
	});

	it("leaves empty history untouched and starts a fresh snapshot only after navigation exits", () => {
		const store = new ChatComposerDraftStore();
		const empty = store.getSnapshot();
		expect(store.navigateHistory("older", [])).toBe(false);
		expect(store.navigateHistory("newer", ["latest"])).toBe(false);
		expect(store.getSnapshot()).toBe(empty);
		store.navigateHistory("older", ["latest", "older"]);
		store.navigateHistory("older", ["newly received", "latest", "older"]);
		expect(store.getSnapshot().text).toBe("older");
		store.navigateHistory("newer", []);
		expect(store.getSnapshot().text).toBe("latest");
		store.navigateHistory("newer", []);
		store.navigateHistory("older", ["newly received", "latest", "older"]);
		expect(store.getSnapshot().text).toBe("newly received");
	});

	it("keeps repeated messages as separate positions in the Session history", () => {
		const store = new ChatComposerDraftStore();
		const history = ["same", "same", "oldest"];
		store.navigateHistory("older", history);
		store.navigateHistory("older", history);
		expect(store.getSnapshot().text).toBe("same");
		store.navigateHistory("older", history);
		expect(store.getSnapshot().text).toBe("oldest");
		store.navigateHistory("newer", history);
		store.navigateHistory("newer", history);
		expect(store.getSnapshot()).toEqual({ text: "same", navigatingHistory: true });
		store.navigateHistory("newer", history);
		expect(store.getSnapshot()).toEqual({ text: "", navigatingHistory: false });
	});

	it("exits history when the recalled text is edited, including setting the same text", () => {
		const store = new ChatComposerDraftStore();
		store.navigateHistory("older", [referencedMessage, "older"]);
		store.set(referencedMessage);
		expect(store.getSnapshot()).toEqual({ text: referencedMessage, navigatingHistory: false });
		expect(store.navigateHistory("newer", [referencedMessage, "older"])).toBe(false);
		expect(store.navigateHistory("older", [referencedMessage, "older"])).toBe(false);
		store.set("");
		store.navigateHistory("older", ["fresh history"]);
		expect(store.getSnapshot()).toEqual({ text: "fresh history", navigatingHistory: true });
	});

	it("clears navigation on submission and restores only the rejected submitted text", () => {
		const store = new ChatComposerDraftStore();
		store.navigateHistory("older", [referencedMessage, "older"]);
		const restore = store.clearForSubmission();
		expect(store.getSnapshot()).toEqual({ text: "", navigatingHistory: false });
		restore();
		expect(store.getSnapshot()).toEqual({ text: referencedMessage, navigatingHistory: false });
		expect(store.navigateHistory("newer", [referencedMessage, "older"])).toBe(false);
	});

	it("does not overwrite a new history selection when an earlier submission fails", () => {
		const store = new ChatComposerDraftStore();
		store.set("submitted text");
		const restore = store.clearForSubmission();
		store.navigateHistory("older", ["latest message", "older message"]);
		restore();
		expect(store.getSnapshot()).toEqual({ text: "latest message", navigatingHistory: true });
		store.navigateHistory("newer", []);
		restore();
		expect(store.getSnapshot()).toEqual({ text: "", navigatingHistory: false });
	});
});

describe("useChatComposerDraft lifecycle", () => {
	it("retains independent exact drafts across Session switches and unmounts", () => {
		hook(sessionA).setDraft(referencedMessage);
		expect(hook(sessionB).draft).toBe("");
		hook(sessionB).setDraft("另一个会话\n\n还没发送");
		expect(hook(sessionA).draft).toBe(referencedMessage);
		driver.unmount(); driver = new DraftHookDriver();
		expect(hook(sessionA).draft).toBe(referencedMessage);
		expect(hook(sessionB).draft).toBe("另一个会话\n\n还没发送");
		expect(getChatComposerDraftStore(sessionA)).toBe(getChatComposerDraftStore(sessionA));
	});

	it("releases the previous subscription on navigation and the current one on unmount", () => {
		const first = getChatComposerDraftStore(sessionA), second = getChatComposerDraftStore(sessionB);
		const subscribeFirst = vi.spyOn(first, "subscribe"), subscribeSecond = vi.spyOn(second, "subscribe");
		hook(sessionA); hook(sessionA);
		expect(subscribeFirst).toHaveBeenCalledOnce();
		first.set("first");
		expect(driver.notify).toHaveBeenCalledOnce();
		hook(sessionB);
		first.set("unobserved"); second.set("second");
		expect(driver.notify).toHaveBeenCalledTimes(2);
		expect(subscribeSecond).toHaveBeenCalledOnce();
		driver.unmount(); second.set("also unobserved");
		expect(driver.notify).toHaveBeenCalledTimes(2);
	});

	it("keeps submission recovery bound to its original Session after the view unmounts", () => {
		hook(sessionA).setDraft(referencedMessage);
		const restore = hook(sessionA).clearForSubmission();
		hook(sessionB).setDraft("B draft");
		driver.unmount(); restore(); driver = new DraftHookDriver();
		expect(hook(sessionB).draft).toBe("B draft");
		expect(hook(sessionA).draft).toBe(referencedMessage);
	});

	it("isolates the navigation snapshot and cursor across Session switches and remounts", () => {
		hook(sessionA).navigateHistory("older", [referencedMessage, "A older"]);
		hook(sessionB).navigateHistory("older", ["B latest", "B older"]);
		hook(sessionA).navigateHistory("older", ["A newly received", referencedMessage, "A older"]);
		expect(hook(sessionA)).toMatchObject({ draft: "A older", navigatingHistory: true });
		expect(hook(sessionB)).toMatchObject({ draft: "B latest", navigatingHistory: true });
		driver.unmount(); driver = new DraftHookDriver();
		hook(sessionA).navigateHistory("newer", []);
		expect(hook(sessionA)).toMatchObject({ draft: referencedMessage, navigatingHistory: true });
		hook(sessionB).navigateHistory("newer", []);
		expect(hook(sessionB)).toMatchObject({ draft: "", navigatingHistory: false });
	});
});

type PanelProps = ComponentProps<typeof ChatComposerPanel>;
type EditorProps = ComponentProps<typeof ChatTokenEditor>;
const renderPanel = (ChatComposerPanel as unknown as {
	render(props: PanelProps, ref: Ref<ChatComposerPanelHandle>): ReactNode;
}).render;
const handle: { current: ChatComposerPanelHandle | null } = { current: null };
let panelTree: ReactNode;
function panel(sessionId: string, overrides: Partial<PanelProps> = {}) {
	const props: PanelProps = {
		sessionId, recentUserTexts: [referencedMessage], contextUsage: null, active: true,
		model: null, thinkingLevel: "off", modelSelectionLoading: false, modelSelectionError: null, modelSelectionRetryable: false,
		onRetryModelSelection: vi.fn(), onSelectModel: vi.fn(), onSelectThinkingLevel: vi.fn(), composerTools: [], onToolSelect: vi.fn(),
		submitting: false, cancelling: false, terminalBusy: false, onSubmit: vi.fn().mockResolvedValue(true), onCancel: vi.fn(),
		autoAuditChecked: true, autoAuditPending: false, autoAuditError: null, onClearAutoAuditError: vi.fn(), onUpdateAutoAudit: vi.fn(),
		runtimeError: null, onClearRuntimeError: vi.fn(), manualCompactionResult: null, compacting: false, onClearManualCompactionResult: vi.fn(),
		queue: [], queueMutationId: null, onCancelQueued: vi.fn(), onPromoteQueued: vi.fn(), ...overrides,
	};
	panelTree = driver.render(() => renderPanel(props, handle));
	const editor = findEditor(panelTree);
	if (!editor) throw new Error("Composer must render the token editor");
	return editor;
}
function findEditor(node: ReactNode): ReactElement<EditorProps> | undefined {
	let found: ReactElement<EditorProps> | undefined;
	Children.forEach(node, (child) => {
		if (found || !isValidElement<{ children?: ReactNode }>(child)) return;
		if (child.type === ChatTokenEditor) found = child as ReactElement<EditorProps>;
		else if (child.props.children) found = findEditor(child.props.children);
	});
	return found;
}

describe("composer draft wiring", () => {
	it("isolates a Session-keyed deployment picker from the Session-keyed editor", () => {
		panel(sessionA).props.onChange("保留草稿");
		panel(sessionA, { aboveInputPanel: <div key={sessionA}>Deployment picker</div> });
		const duplicateKeys: string[] = [];
		const inspect = (node: ReactNode) => {
			const keys = new Set<string>();
			Children.forEach(node, (child) => {
				if (!isValidElement<{ children?: ReactNode }>(child)) return;
				if (child.key !== null) {
					if (keys.has(child.key)) duplicateKeys.push(child.key);
					keys.add(child.key);
				}
				inspect(child.props.children);
			});
		};
		inspect(panelTree);
		expect(duplicateKeys).toEqual([]);
		expect(panel(sessionA).props.value).toBe("保留草稿");
	});

	it("uses cached Session text for the editor and accepts imperative message restoration", () => {
		panel(sessionA).props.onChange(referencedMessage);
		expect(panel(sessionB).props.value).toBe("");
		panel(sessionB).props.onChange("B draft");
		expect(panel(sessionA).props.value).toBe(referencedMessage);
		handle.current!.restoreDraft("恢复的消息\n<folder name=\"src\" path=\"/work/src\" />");
		expect(panel(sessionA).props.value).toBe("恢复的消息\n<folder name=\"src\" path=\"/work/src\" />");
		driver.unmount(); driver = new DraftHookDriver();
		expect(panel(sessionB).props.value).toBe("B draft");
	});

	it("wires both history directions and navigation state without altering file tokens", () => {
		const recentUserTexts = [referencedMessage, "older message"];
		const render = () => panel(sessionA, { recentUserTexts });
		expect(render().props.navigatingHistory).toBe(false);
		expect(render().props.onNavigateHistory?.("older")).toBe(true);
		expect(render().props.navigatingHistory).toBe(true);
		expect(panel(sessionA).props.value).toBe(referencedMessage);
		expect(render().props.onNavigateHistory?.("older")).toBe(true);
		expect(render().props.value).toBe("older message");
		expect(render().props.onNavigateHistory?.("newer")).toBe(true);
		expect(render().props.value).toBe(referencedMessage);
		expect(render().props.onNavigateHistory?.("newer")).toBe(true);
		expect(render().props.value).toBe("");
		expect(render().props.navigatingHistory).toBe(false);
		render().props.onChange("正在输入");
		expect(render().props.onNavigateHistory?.("older")).toBe(false);
		expect(render().props.value).toBe("正在输入");
	});

	it("clears successful submissions and keeps them empty after reopening the Session", async () => {
		const onSubmit = vi.fn().mockResolvedValue(true);
		panel(sessionA, { onSubmit }).props.onChange(referencedMessage);
		panel(sessionA, { onSubmit }).props.onSubmit();
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(referencedMessage, []);
		expect(panel(sessionA).props.value).toBe("");
		await Promise.resolve();
		driver.unmount(); driver = new DraftHookDriver();
		expect(panel(sessionA).props.value).toBe("");
	});

	it("restores failed submissions to their original Session while preserving the visible Session", async () => {
		const submission = deferred<boolean>();
		const onSubmit = vi.fn().mockReturnValue(submission.promise);
		panel(sessionA, { onSubmit }).props.onChange(referencedMessage);
		panel(sessionA, { onSubmit }).props.onSubmit();
		panel(sessionB).props.onChange("B draft");
		submission.resolve(false); await submission.promise;
		expect(panel(sessionB).props.value).toBe("B draft");
		expect(panel(sessionA).props.value).toBe(referencedMessage);
	});

	it.each(["新草稿", ""])("does not replace later edits with failed submitted text: %j", async (newDraft) => {
		const submission = deferred<boolean>();
		const onSubmit = vi.fn().mockReturnValue(submission.promise);
		panel(sessionA, { onSubmit }).props.onChange(referencedMessage);
		panel(sessionA, { onSubmit }).props.onSubmit();
		panel(sessionA).props.onChange("先修改");
		panel(sessionA).props.onChange(newDraft);
		submission.resolve(false); await submission.promise;
		expect(panel(sessionA).props.value).toBe(newDraft);
	});
});
