import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../features/chat/model/chat";
import type { ChatTimelineEntry } from "../features/chat/model/chat-runtime-state";
import { HookDriver, deferred } from "./helpers/hook-driver";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => driver.state(initial),
	useRef: (initial: unknown) => driver.ref(initial),
	useMemo: (factory: () => unknown, deps: readonly unknown[]) => driver.memo(factory, deps),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
}));
vi.mock("../features/chat/api/chat-api", () => ({ chatApi: { listMessages: vi.fn() } }));
import { chatApi } from "../features/chat/api/chat-api";
import { useChatComposerHistory } from "../features/chat/runtime/use-chat-composer-history";

type MessagePage = Awaited<ReturnType<typeof chatApi.listMessages>>;
let sessionId: string, timeline: ChatTimelineEntry[], loading: boolean;
const render = () => driver.render(() => useChatComposerHistory(sessionId, timeline, loading));
async function settle() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); return render(); }
function user(sequence: number, text = `user-${sequence}`, id = `message-${sequence}`): ChatMessage {
	return { id, sequence, createdAt: sequence, message: { role: "user", content: text, timestamp: sequence } };
}
function tool(sequence: number): ChatMessage {
	return { id: `tool-${sequence}`, sequence, createdAt: sequence, message: {
		role: "toolResult", toolCallId: `call-${sequence}`, toolName: "read", content: [{ type: "text", text: "tool output" }], isError: false, timestamp: sequence,
	} };
}
function entry(message: ChatMessage): ChatTimelineEntry {
	return { key: `persisted:${message.id}`, sequence: message.sequence, message: message.message, final: true };
}
function page(messages: ChatMessage[], nextBeforeSequence: number | null = null): MessagePage {
	return { messages, nextBeforeSequence, nextSequence: null };
}

beforeEach(() => {
	driver = new HookDriver(); sessionId = "a"; timeline = []; loading = false;
	vi.mocked(chatApi.listMessages).mockReset().mockResolvedValue(page([]));
});
afterEach(() => { driver.unmount(); });

describe("Composer supplemental recall history", () => {
	it("waits for the main history and starts before its minimum positive sequence", async () => {
		loading = true;
		timeline = [entry(user(120, "latest")), entry(tool(100)), entry(tool(0)), entry(tool(-1))];
		expect(render()).toEqual(["latest"]);
		expect(chatApi.listMessages).not.toHaveBeenCalled();
		vi.mocked(chatApi.listMessages).mockResolvedValueOnce(page([user(90, "older")]));
		loading = false; render();
		expect(await settle()).toEqual(["latest", "older"]);
		expect(chatApi.listMessages).toHaveBeenCalledExactlyOnceWith("a", { beforeSequence: 100, limit: 100 });
	});

	it("skips auxiliary reads when seven user messages are already present or no persisted cursor exists", async () => {
		timeline = Array.from({ length: 7 }, (_, index) => entry(user(index + 1)));
		expect(render()).toEqual(["user-7", "user-6", "user-5", "user-4", "user-3", "user-2", "user-1"]);
		await settle();
		expect(chatApi.listMessages).not.toHaveBeenCalled();
		driver.unmount(); driver = new HookDriver();
		timeline = [{ key: "live-user", message: { role: "user", content: "new Session", timestamp: 1 }, final: false }];
		expect(render()).toEqual(["new Session"]);
		await settle();
		expect(chatApi.listMessages).not.toHaveBeenCalled();
	});

	it("continues through tool-heavy pages until seven users are available", async () => {
		timeline = [entry(tool(100)), entry(user(120, "latest"))];
		vi.mocked(chatApi.listMessages)
			.mockResolvedValueOnce(page([user(90), tool(95)], 80))
			.mockResolvedValueOnce(page([user(70), tool(75)], 60))
			.mockResolvedValueOnce(page([user(10), user(20), user(30), user(40), user(50)], 5));
		render();
		expect(await settle()).toEqual(["latest", "user-90", "user-70", "user-50", "user-40", "user-30", "user-20"]);
		expect(vi.mocked(chatApi.listMessages).mock.calls.map((call) => call[1]?.beforeSequence)).toEqual([100, 80, 60]);
	});

	it.each([null, 100, 101])("stops when the server cursor is exhausted or fails to decrease: %s", async (cursor) => {
		timeline = [entry(user(100))];
		vi.mocked(chatApi.listMessages).mockResolvedValueOnce(page([user(90)], cursor));
		render();
		expect(await settle()).toEqual(["user-100", "user-90"]);
		expect(chatApi.listMessages).toHaveBeenCalledOnce();
	});

	it("deduplicates by persisted ID, preserves repeated text, and lets live history override auxiliary data", async () => {
		timeline = [entry(user(100, "same"))];
		vi.mocked(chatApi.listMessages).mockResolvedValueOnce(page([
			user(90, "same", "different-message"), user(95, "stale", "shared-message"), user(95, "duplicate", "shared-message"),
		]));
		render(); await settle();
		timeline = [entry(user(90, "live corrected", "different-message")), entry(user(95, "current", "shared-message")), entry(user(100, "same"))];
		expect(render()).toEqual(["same", "current", "live corrected"]);
		timeline = [entry(user(100, "same"))];
		expect(render()).toEqual(["same", "duplicate", "same"]);
		expect(chatApi.listMessages).toHaveBeenCalledOnce();
	});

	it("derives new live candidates without issuing more requests for token updates", async () => {
		timeline = [entry(user(100, "latest"))];
		vi.mocked(chatApi.listMessages).mockResolvedValueOnce(page([user(90, "older")]));
		render(); await settle();
		for (let index = 0; index < 12; index += 1) {
			timeline = [...timeline.filter((item) => item.key !== "live-tool"), { ...entry(tool(110)), key: "live-tool" }];
			render();
		}
		timeline = [...timeline, { key: "live-user", message: { role: "user", content: "new live message", timestamp: 1000 }, final: true }];
		expect(render()).toEqual(["new live message", "latest", "older"]);
		expect(chatApi.listMessages).toHaveBeenCalledOnce();
	});

	it("ignores old Session replies and stops their pagination after navigation", async () => {
		const old = deferred<MessagePage>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([user(190, "B older")]));
		timeline = [entry(user(100, "A latest"))]; render();
		sessionId = "b"; timeline = [entry(user(200, "B latest"))]; render();
		expect(await settle()).toEqual(["B latest", "B older"]);
		old.resolve(page([user(90, "A private message")], 80));
		expect(await settle()).toEqual(["B latest", "B older"]);
		expect(vi.mocked(chatApi.listMessages).mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
	});

	it("does not retain another Session's fetched users during the first render after navigation", async () => {
		vi.mocked(chatApi.listMessages).mockResolvedValueOnce(page([user(90, "A private message")]));
		timeline = [entry(user(100, "A latest"))]; render(); await settle();
		sessionId = "b"; timeline = [entry(user(200, "B latest"))];
		expect(render()).toEqual(["B latest"]);
	});

	it("cancels remaining work after unmount even when the pending API reply succeeds", async () => {
		const pending = deferred<MessagePage>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(pending.promise);
		timeline = [entry(user(100))]; render(); driver.unmount();
		pending.resolve(page([user(90)], 80));
		for (let index = 0; index < 8; index += 1) await Promise.resolve();
		expect(chatApi.listMessages).toHaveBeenCalledOnce();
	});

	it("preserves already available candidates when a later auxiliary page fails", async () => {
		timeline = [entry(user(100, "latest"))];
		vi.mocked(chatApi.listMessages).mockResolvedValueOnce(page([user(90, "older")], 80)).mockRejectedValueOnce(new Error("offline"));
		render();
		expect(await settle()).toEqual(["latest", "older"]);
		timeline = [...timeline, entry(user(110, "can keep chatting"))];
		expect(render()).toEqual(["can keep chatting", "latest", "older"]);
		expect(chatApi.listMessages).toHaveBeenCalledTimes(2);
	});

	it("stops pagination if incoming live users already fill the seven available slots", async () => {
		const pending = deferred<MessagePage>();
		vi.mocked(chatApi.listMessages).mockReturnValueOnce(pending.promise);
		timeline = [entry(tool(100))]; render();
		timeline = [...timeline, ...Array.from({ length: 7 }, (_, index) => entry(user(110 + index)))]; render();
		pending.resolve(page([user(90)], 80));
		expect(await settle()).toEqual(["user-116", "user-115", "user-114", "user-113", "user-112", "user-111", "user-110"]);
		expect(chatApi.listMessages).toHaveBeenCalledOnce();
	});
});
