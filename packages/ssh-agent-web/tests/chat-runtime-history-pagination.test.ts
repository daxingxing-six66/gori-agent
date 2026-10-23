import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../features/chat/model/chat";
import type { ChatRuntimeAction, ChatRuntimeState } from "../features/chat/model/chat-runtime-state";
import { deferred, HookDriver } from "./helpers/hook-driver";

let hooks: HookDriver;
type Effect = { setup: () => void | (() => void); cleanup: void | (() => void) };
const effects = new Set<Effect>();
function effect(setup: Effect["setup"], deps?: readonly unknown[]) {
	hooks.effect(() => {
		const entry = { setup, cleanup: setup() };
		effects.add(entry);
		return () => { entry.cleanup?.(); effects.delete(entry); };
	}, deps);
}
vi.mock("react", () => ({
	useState: (initial: unknown) => hooks.state(initial),
	useRef: (initial: unknown) => hooks.ref(initial),
	useMemo: (factory: () => unknown, deps?: readonly unknown[]) => hooks.memo(factory, deps),
	useCallback: (callback: unknown, deps?: readonly unknown[]) => hooks.memo(() => callback, deps),
	useReducer: (reducer: (state: ChatRuntimeState, action: ChatRuntimeAction) => ChatRuntimeState, initial: ChatRuntimeState) => {
		const [state, setState] = hooks.state(initial);
		return [state, (action: ChatRuntimeAction) => setState(current => reducer(current, action))];
	},
	useEffect: (setup: Effect["setup"], deps?: readonly unknown[]) => effect(setup, deps),
	useLayoutEffect: (setup: Effect["setup"], deps?: readonly unknown[]) => effect(setup, deps),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../features/i18n/components/use-localized-error-message", () => ({ useLocalizedErrorMessage: () => String }));
vi.mock("../features/i18n/components/locale-context", () => ({ useLocale: () => ({ locale: "zh-CN" }) }));
const receiveAttachments = () => {};
vi.mock("../features/chat/runtime/use-chat-attachment-history", () => ({ useChatAttachmentHistory: () => receiveAttachments }));
vi.mock("../features/chat/api/chat-api", () => ({ chatApi: {
	getContextUsage: vi.fn(), getActiveRun: vi.fn(), listMessages: vi.fn(), listApprovals: vi.fn(), listPendingDecisions: vi.fn(),
} }));
import { chatApi } from "../features/chat/api/chat-api";
import { useChatRuntime } from "../features/chat/runtime/use-chat-runtime";

type Page = Awaited<ReturnType<typeof chatApi.listMessages>>;
function page(session: string, sequence: number, nextBeforeSequence: number | null): Page {
	const message: ChatMessage = { id: `${session}:${sequence}`, sequence, createdAt: sequence,
		message: { role: "user", content: session, timestamp: sequence } };
	return { messages: [message], nextBeforeSequence, nextSequence: sequence };
}
let session = "a";
const render = () => hooks.render(() => useChatRuntime(session));
async function settle() { for (let tick = 0; tick < 20; tick++) await Promise.resolve(); return render(); }
async function initialized() { render(); return settle(); }

beforeEach(() => {
	hooks = new HookDriver(); effects.clear(); session = "a"; vi.resetAllMocks();
	vi.mocked(chatApi.getContextUsage).mockResolvedValue({ contextUsage: null });
	vi.mocked(chatApi.getActiveRun).mockResolvedValue({ run: null });
	vi.mocked(chatApi.listApprovals).mockResolvedValue({ approvals: [] });
	vi.mocked(chatApi.listPendingDecisions).mockResolvedValue({ decisions: [] });
	vi.mocked(chatApi.listMessages).mockImplementation(async id => page(id, 100, 100));
});
afterEach(() => hooks.unmount());

describe("Chat history pagination request ownership", () => {
	it("merges a current page, advances its cursor and rejects duplicate requests before a rerender", async () => {
		const runtime = await initialized(); const pending = deferred<Page>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(pending.promise);
		const request = runtime.loadOlderMessages();
		expect(await runtime.loadOlderMessages()).toBe(false);
		expect(render().loadingOlderMessages).toBe(true);
		pending.resolve(page("a", 50, 50)); expect(await request).toBe(true);
		const updated = render();
		expect(updated.state.timeline.map(entry => entry.sequence)).toEqual([50, 100]);
		expect(updated.loadingOlderMessages).toBe(false);
		vi.mocked(chatApi.listMessages).mockResolvedValueOnce(page("a", 25, null));
		await updated.loadOlderMessages();
		expect(chatApi.listMessages).toHaveBeenLastCalledWith("a", { beforeSequence: 50, limit: 100 });
		expect(render().hasOlderMessages).toBe(false);
	});

	it.each(["resolve", "reject"] as const)("ignores an old Session's %s without releasing a new request or replacing its error", async outcome => {
		const original = await initialized(); const oldPage = deferred<Page>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(oldPage.promise);
		const oldRequest = original.loadOlderMessages();
		session = "b"; render(); const current = await settle(); const newPage = deferred<Page>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(newPage.promise);
		const newRequest = current.loadOlderMessages();
		if (outcome === "resolve") oldPage.resolve(page("a", 50, null)); else oldPage.reject(new Error("old failure"));
		expect(await oldRequest).toBe(false);
		const waiting = render();
		expect(waiting.state.timeline.map(entry => entry.key)).toEqual(["persisted:b:100"]);
		expect(waiting.error).toBeNull(); expect(waiting.loadingOlderMessages).toBe(true);
		expect(await waiting.loadOlderMessages()).toBe(false);
		newPage.resolve(page("b", 75, null)); expect(await newRequest).toBe(true);
		expect(render().state.timeline.map(entry => entry.key)).toEqual(["persisted:b:75", "persisted:b:100"]);
		expect(render().loadingOlderMessages).toBe(false);
	});

	it("does not reuse a cursor from the previous Session before initial history hydration", async () => {
		const oldRuntime = await initialized(); const calls = vi.mocked(chatApi.listMessages).mock.calls.length;
		session = "b"; const firstRender = render();
		expect(await firstRender.loadOlderMessages()).toBe(false);
		expect(await oldRuntime.loadOlderMessages()).toBe(false);
		await settle();
		expect(vi.mocked(chatApi.listMessages).mock.calls.slice(calls)).toEqual([["b", { limit: 100 }]]);
	});

	it("isolates A to B to A transitions even though the final Session ID matches the old request", async () => {
		const old = await initialized(); const oldPage = deferred<Page>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(oldPage.promise); const request = old.loadOlderMessages();
		session = "b"; render(); await settle(); session = "a"; render(); const current = await settle();
		const freshPage = deferred<Page>(); vi.mocked(chatApi.listMessages).mockReturnValueOnce(freshPage.promise);
		const freshRequest = current.loadOlderMessages();
		oldPage.resolve(page("stale-a", 10, null)); expect(await request).toBe(false);
		expect(render().state.timeline.map(entry => entry.key)).toEqual(["persisted:a:100"]);
		expect(render().loadingOlderMessages).toBe(true);
		freshPage.resolve(page("a", 90, null)); expect(await freshRequest).toBe(true);
	});

	it.each(["resolve", "reject"] as const)("discards a pending %s after unmount and blocks detached callbacks", async outcome => {
		const runtime = await initialized(); const pending = deferred<Page>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(pending.promise); const request = runtime.loadOlderMessages();
		hooks.unmount();
		if (outcome === "resolve") pending.resolve(page("a", 50, null)); else pending.reject(new Error("detached"));
		expect(await request).toBe(false);
		const calls = vi.mocked(chatApi.listMessages).mock.calls.length;
		expect(await runtime.loadOlderMessages()).toBe(false);
		expect(vi.mocked(chatApi.listMessages).mock.calls).toHaveLength(calls);
	});

	it("invalidates a request across StrictMode effect cleanup and setup", async () => {
		const runtime = await initialized(); const pending = deferred<Page>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(pending.promise); const request = runtime.loadOlderMessages();
		for (const entry of effects) entry.cleanup?.();
		for (const entry of effects) entry.cleanup = entry.setup();
		const current = await settle(); const freshPage = deferred<Page>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(freshPage.promise); const freshRequest = current.loadOlderMessages();
		pending.resolve(page("stale", 10, null)); expect(await request).toBe(false);
		expect(render().loadingOlderMessages).toBe(true);
		freshPage.resolve(page("a", 80, null)); expect(await freshRequest).toBe(true);
		expect(render().state.timeline.map(entry => entry.key)).toEqual(["persisted:a:80", "persisted:a:100"]);
	});
});
