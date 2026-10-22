import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatRun } from "../features/chat/model/chat";
import { deferred } from "./helpers/hook-driver";
import { chatRuntimeReducer, initialChatRuntimeState, type ChatRuntimeAction, type ChatRuntimeState } from "../features/chat/model/chat-runtime-state";

let projected: ChatRuntimeState;
vi.mock("react", () => ({
	useCallback: (callback: unknown) => callback,
	useMemo: (factory: () => unknown) => factory(),
	useState: (initial: unknown) => [initial, () => {}],
	useRef: (current: unknown) => ({ current }),
	useReducer: () => [projected, (action: ChatRuntimeAction) => { projected = chatRuntimeReducer(projected, action); }],
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
	useEffect: () => {},
	useLayoutEffect: () => {},
}));
vi.mock("../features/i18n/components/use-localized-error-message", () => ({ useLocalizedErrorMessage: () => String }));
vi.mock("../features/i18n/components/locale-context", () => ({ useLocale: () => ({ locale: "zh-CN" }) }));
vi.mock("../features/chat/api/chat-api", () => ({ chatApi: {
	cancelRun: vi.fn(), listMessages: vi.fn(), getActiveRun: vi.fn(), listApprovals: vi.fn(), listPendingDecisions: vi.fn(), listQueue: vi.fn(),
	createRun: vi.fn(),
} }));
import { chatApi } from "../features/chat/api/chat-api";
import { useChatRuntime } from "../features/chat/runtime/use-chat-runtime";

const run: ChatRun = {
	id: "run", sessionId: "session", workspaceId: "workspace", requestId: "request", providerId: "provider", modelId: "model",
	thinkingLevel: "off", serverInteractionMode: "command", terminalSessionId: null, status: "running", createdAt: 1, updatedAt: 2,
};

beforeEach(() => {
	vi.resetAllMocks();
	projected = { ...initialChatRuntimeState, run, queue: { q: { id: "q", behavior: "follow_up", status: "pending", message: "next" } } };
	vi.mocked(chatApi.listMessages).mockResolvedValue({ messages: [], nextBeforeSequence: null, nextSequence: null });
	vi.mocked(chatApi.getActiveRun).mockResolvedValue({ run });
	vi.mocked(chatApi.listApprovals).mockResolvedValue({ approvals: [] });
	vi.mocked(chatApi.listPendingDecisions).mockResolvedValue({ decisions: [] });
});

describe("stop response synchronization", () => {
	it("recovers the diagnosis card and prompt even if a card event already advanced maxSequence, without waiting for pending controls", async () => {
		const timestamp = 1_800_000_000_000;
		const earlier: ChatMessage = { id: "earlier", sequence: 41, runId: "old-run", createdAt: timestamp,
			message: { role: "assistant", content: [{ type: "text", text: "Earlier reply" }], provider: "provider", model: "model", stopReason: "stop", timestamp } };
		const card: ChatMessage = { id: "diagnose:task", sequence: 42, createdAt: timestamp + 10,
			message: { role: "custom", customType: "diagnose", content: "Diagnosis", display: true, timestamp: timestamp + 10, details: { taskId: "task" } } };
		const prompt: ChatMessage = { id: "prompt", sequence: 43, runId: run.id, createdAt: timestamp + 20,
			message: { role: "user", content: "Start diagnosis", timestamp: timestamp + 20 } };
		projected = chatRuntimeReducer(initialChatRuntimeState, { type: "event", event: { type: "message_end", data: { type: "message_end", message: earlier.message } } });
		projected = chatRuntimeReducer(projected, { type: "mergePersisted", messages: [card] });
		vi.mocked(chatApi.listMessages).mockImplementation(async (_sessionId, query) => ({
			messages: [earlier, card, prompt].filter((message) => message.sequence > (query?.afterSequence ?? 0)), nextBeforeSequence: null, nextSequence: null,
		}));
		const approvals = deferred<Awaited<ReturnType<typeof chatApi.listApprovals>>>();
		const decisions = deferred<Awaited<ReturnType<typeof chatApi.listPendingDecisions>>>();
		const queue = deferred<Awaited<ReturnType<typeof chatApi.listQueue>>>();
		vi.mocked(chatApi.listApprovals).mockReturnValue(approvals.promise);
		vi.mocked(chatApi.listPendingDecisions).mockReturnValue(decisions.promise);
		vi.mocked(chatApi.listQueue).mockReturnValue(queue.promise);
		const attaching = useChatRuntime("session").attachRun(run);
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();
		expect(chatApi.listMessages).toHaveBeenCalledWith("session", { limit: 100 });
		expect(projected.timeline.map((entry) => entry.sequence)).toEqual([41, 42, 43]);
		approvals.resolve({ approvals: [] }); decisions.resolve({ decisions: [] }); queue.resolve({ items: [] }); await attaching;
		expect(projected.timeline).toHaveLength(3);
	});
	it("submits once before React rerenders and attaches ordinary Chat without a competing history hydration", async () => {
		projected = initialChatRuntimeState;
		let complete!: (run: ChatRun) => void;
		vi.mocked(chatApi.createRun).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
		const runtime = useChatRuntime("session");
		const input = { message: "观察一下", attachments: [], model: { id: "model", providerId: "provider" },
			thinkingLevel: "off" as const, behavior: "follow_up" as const, serverInteractionMode: "command" as const };
		const first = runtime.submit(input); const duplicate = runtime.submit(input);
		expect(await duplicate).toBeNull(); expect(chatApi.createRun).toHaveBeenCalledOnce();
		complete({ ...run, requestId: vi.mocked(chatApi.createRun).mock.calls[0]![1].requestId }); await first;
		expect(projected.timeline).toHaveLength(1); expect(projected.timeline[0]?.runId).toBe(run.id);
		expect(chatApi.listMessages).not.toHaveBeenCalled();
	});
	it("retains queued controls while the same Run resumes, even if the recovery request fails", async () => {
		vi.mocked(chatApi.cancelRun).mockResolvedValue(run);
		vi.mocked(chatApi.listQueue).mockRejectedValue(new Error("offline"));
		await useChatRuntime("session").cancel();
		expect(chatApi.cancelRun).toHaveBeenCalledWith("session", "run");
		expect(projected.run).toEqual(run);
		expect(projected.queue.q).toMatchObject({ status: "pending", message: "next" });
	});

	it("clears pending controls when stopping really ends the Run", async () => {
		vi.mocked(chatApi.cancelRun).mockResolvedValue({ ...run, status: "cancelled", finishedAt: 3, updatedAt: 3 });
		vi.mocked(chatApi.getActiveRun).mockResolvedValue({ run: null });
		await useChatRuntime("session").cancel();
		expect(projected.queue).toEqual({});
		expect(projected.run).toBeNull();
	});

	it("keeps the queue intact if the stop request itself fails", async () => {
		vi.mocked(chatApi.cancelRun).mockRejectedValue(new Error("offline"));
		await useChatRuntime("session").cancel();
		expect(projected.queue.q?.status).toBe("pending");
		expect(chatApi.listMessages).not.toHaveBeenCalled();
	});
});
