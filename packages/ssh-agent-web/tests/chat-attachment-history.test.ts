import type { RefObject } from "react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ChatMessage, ChatRun, ChatStreamEvent } from "../features/chat/model/chat";
import { chatRuntimeReducer, initialChatRuntimeState, type ChatRuntimeAction, type ChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import type { SessionAttachment } from "../features/session/api/session-attachment-api";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useRef: (current: unknown) => driver.ref(current),
	useCallback: <T,>(callback: T) => callback,
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
}));
vi.mock("../features/chat/api/chat-api", () => ({ chatApi: { listMessages: vi.fn() } }));

import { chatApi } from "../features/chat/api/chat-api";
import { useChatAttachmentHistory } from "../features/chat/runtime/use-chat-attachment-history";

class HookDriver {
	private refs: RefObject<unknown>[] = [];
	private effects: { deps: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
	private refIndex = 0;
	private effectIndex = 0;
	ref<T>(current: T): RefObject<T> {
		const index = this.refIndex++;
		this.refs[index] ??= { current };
		return this.refs[index] as RefObject<T>;
	}
	effect(effect: () => void | (() => void), deps: readonly unknown[]) {
		const index = this.effectIndex++;
		const previous = this.effects[index];
		if (previous?.deps.length === deps.length && deps.every((value, key) => Object.is(value, previous.deps[key]))) return;
		previous?.cleanup?.();
		this.effects[index] = { deps, cleanup: effect() };
	}
	render<T>(render: () => T): T { this.refIndex = this.effectIndex = 0; return render(); }
	unmount(): void { this.effects.forEach((effect) => effect.cleanup?.()); }
}

const run: ChatRun = { id: "run", sessionId: "a", workspaceId: "w", requestId: "request", providerId: "provider", modelId: "model",
	thinkingLevel: "off", serverInteractionMode: "command", terminalSessionId: null, status: "running", createdAt: 1, updatedAt: 1 };
type MessagePage = Awaited<ReturnType<typeof chatApi.listMessages>>;
function deferredPage() {
	let resolve!: (value: MessagePage) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<MessagePage>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function document(id: string, sessionId = "a"): SessionAttachment {
	return { id, sessionId, name: `${id}.md`, mimeType: "text/markdown", size: 10, storagePath: "unused", contentUrl: "unused", createdAt: 1 };
}
function event(id: string, timestamp = 100): Extract<ChatStreamEvent, { type: "message_end" }> {
	const message = { role: "user" as const, content: "", timestamp, attachmentIds: [id] };
	return { type: "message_end", data: { type: "message_end", message } };
}
function persisted(id: string, sequence = 6, timestamp = 100): ChatMessage {
	return { id: `message-${id}`, runId: "run", sequence, message: event(id, timestamp).data.message, attachments: [document(id)], createdAt: timestamp };
}
function page(...messages: ChatMessage[]): MessagePage { return { messages, nextSequence: null, nextBeforeSequence: null }; }
async function flush(): Promise<void> { for (let count = 0; count < 8; count++) await Promise.resolve(); }

let state: RefObject<ChatRuntimeState>;
let dispatch: (action: ChatRuntimeAction) => void;
let onError: Mock<(error: unknown) => void>;
function render(sessionId = "a") { return driver.render(() => useChatAttachmentHistory(sessionId, state, dispatch, onError)); }

beforeEach(() => {
	driver = new HookDriver();
	vi.mocked(chatApi.listMessages).mockReset();
	state = { current: { ...initialChatRuntimeState, run, maxSequence: 5 } };
	dispatch = (action) => { state.current = chatRuntimeReducer(state.current, action); };
	onError = vi.fn();
});

describe("attachment history synchronization", () => {
	it("restores queued attachment-only cards after consumption even when the Run finishes before the history response", async () => {
		const response = deferredPage();
		vi.mocked(chatApi.listMessages).mockReturnValue(response.promise);
		const receive = render();
		dispatch({ type: "event", event: { type: "queue.updated", data: { id: "queued", status: "consumed" } } });
		dispatch({ type: "event", event: event("doc") });
		receive(event("doc"));
		expect(state.current.timeline[0]?.attachments).toBeUndefined();
		dispatch({ type: "event", event: { type: "run.updated", data: { ...run, status: "completed", finishedAt: 200 } } });
		render();
		response.resolve(page(persisted("doc"))); await flush();
		expect(state.current.timeline).toHaveLength(1);
		expect(state.current.timeline[0]?.attachments).toEqual([document("doc")]);
		expect(state.current.run?.status).toBe("completed");
		expect(chatApi.listMessages).toHaveBeenCalledExactlyOnceWith("a", { afterSequence: 5, limit: 100 });
	});

	it("does not query for deltas, tool events, already displayed optimistic attachments or duplicate message completions", async () => {
		vi.mocked(chatApi.listMessages).mockResolvedValue(page(persisted("doc")));
		const receive = render();
		receive({ type: "message_start", data: { type: "message_start", message: event("doc").data.message } });
		receive({ type: "tool_execution_update", data: { type: "tool_execution_update", toolCallId: "tool", toolName: "read", update: { type: "text", detail: { content: "streamed", mode: "replace" } } } });
		receive({ type: "message_update", data: { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working", partial: { role: "assistant", content: [{ type: "text", text: "working" }], provider: "p", model: "m", stopReason: "stop", timestamp: 90 } } } });
		dispatch({ type: "optimisticUser", requestId: "request", message: "", attachments: [document("doc")], timestamp: 99 });
		receive(event("doc"));
		expect(chatApi.listMessages).not.toHaveBeenCalled();
		state.current = { ...state.current, timeline: [] };
		receive(event("doc")); receive(event("doc")); await flush(); receive(event("doc"));
		expect(chatApi.listMessages).toHaveBeenCalledOnce();
	});

	it("serializes reads and retains the earliest pending cursor instead of skipping metadata behind a newer sequence", async () => {
		const first = deferredPage(), second = deferredPage();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const receive = render();
		receive(event("first", 100));
		state.current = { ...state.current, maxSequence: 10 }; receive(event("second", 200));
		state.current = { ...state.current, maxSequence: 12 }; receive(event("third", 300));
		state.current = { ...state.current, maxSequence: 20 };
		expect(chatApi.listMessages).toHaveBeenCalledOnce();
		first.resolve(page(persisted("first", 6, 100))); await flush();
		expect(chatApi.listMessages).toHaveBeenCalledTimes(2);
		expect(vi.mocked(chatApi.listMessages).mock.calls[1]).toEqual(["a", { afterSequence: 10, limit: 100 }]);
		second.resolve(page(persisted("second", 11, 200), persisted("third", 13, 300))); await flush();
		expect(state.current.timeline.flatMap((entry) => entry.attachments ?? []).map((attachment) => attachment.id)).toEqual(["first", "second", "third"]);
	});

	it("discards responses after a Session switch or unmount, including a switch back to the same Session", async () => {
		const old = deferredPage(), latest = deferredPage();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
		render()(event("old"));
		render("b");
		state.current = { ...initialChatRuntimeState, run };
		render("a")(event("latest"));
		old.resolve(page(persisted("old"))); await flush();
		expect(state.current.timeline).toEqual([]);
		driver.unmount();
		latest.resolve(page(persisted("latest"))); await flush();
		expect(state.current.timeline).toEqual([]);
	});

	it("reports a failed metadata read without replacing Run or tool state", async () => {
		vi.mocked(chatApi.listMessages).mockRejectedValue(new Error("offline"));
		const receive = render();
		receive(event("doc")); await flush();
		expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("offline"));
		expect(state.current.run).toEqual(run);
		expect(state.current.tools).toEqual({});
	});
});
