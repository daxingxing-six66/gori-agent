import { describe, expect, it, vi } from "vitest";
import { ChatEventStream, parseChatStreamEvent } from "../features/chat/runtime/chat-event-stream";

describe("Chat failure event contract", () => {
	it("accepts compaction failures without tokensBefore", () => {
		const data = { reason: "overflow", attempt: 1, code: "chat_context_no_compactable_history", message: "No history" };
		expect(parseChatStreamEvent("compaction.failed", data)).toEqual({ type: "compaction.failed", data });
	});
	it("requests resynchronization on a malformed known event without logging its payload", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const listeners = new Map<string, (event: Event) => void>();
		const stream = new ChatEventStream("session", "run", "en-US", () => ({
			addEventListener: (type, listener) => { listeners.set(type, listener); },
			close: () => undefined, onerror: null, onopen: null,
		}));
		const receive = vi.fn();
		stream.subscribe(receive);
		try {
			listeners.get("run.updated")!(new MessageEvent("run.updated", { data: '{"private":"credential"}' }));
			expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "stream.resync", data: { eventType: "run.updated" } });
			expect(JSON.stringify(log.mock.calls)).not.toContain("credential");
		} finally { stream.close(); log.mockRestore(); }
	});
});
