import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActivityReadState, createBrowserActivityReadState } from "../features/session-activity/runtime/session-activity-read-state";
import { SessionActivityStore } from "../features/session-activity/runtime/session-activity-store";

afterEach(() => vi.unstubAllGlobals());

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => { values.set(key, value); },
	};
}

describe("session activity read receipts", () => {
	it("restores acknowledged results after a browser reload without dismissing another Run or session", () => {
		const storage = memoryStorage();
		const result = { sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a", state: "completed" as const };
		const store = new SessionActivityStore(new SessionActivityReadState(storage));
		store.applySnapshot([result]);
		store.acknowledge("session-a");
		const reloaded = new SessionActivityStore(new SessionActivityReadState(storage));
		reloaded.applySnapshot([result, { ...result, sessionId: "session-b", runId: "run-b" }]);
		expect(reloaded.state("session-a")).toBe("idle");
		expect(reloaded.state("session-b")).toBe("completed");
		const receipts = new SessionActivityReadState(storage);
		expect(receipts.hasRead("session-a", "next-run")).toBe(false);
	});

	it("bounds receipt storage and refreshes only the acknowledged session's entry", () => {
		const storage = memoryStorage();
		const receipts = new SessionActivityReadState(storage);
		for (let i = 0; i < 256; i++) receipts.markRead(`session-${i}`, `run-${i}`);
		receipts.markRead("session-0", "new-run");
		receipts.markRead("session-256", "run-256");
		const restored = new SessionActivityReadState(storage);
		expect(restored.hasRead("session-0", "new-run")).toBe(true);
		expect(restored.hasRead("session-1", "run-1")).toBe(false);
		expect(restored.hasRead("session-256", "run-256")).toBe(true);
	});

	it.each(["invalid JSON", "{}", '[["session-a"]]', '[["session-a", 7]]', '[["", "run-a"]]'])("ignores malformed persisted receipts: %s", (value) => {
		const receipts = new SessionActivityReadState({ getItem: () => value, setItem: () => {} });
		expect(receipts.hasRead("session-a", "run-a")).toBe(false);
		receipts.markRead("session-a", "run-a");
		expect(receipts.hasRead("session-a", "run-a")).toBe(true);
	});

	it("keeps acknowledgement working when browser storage is unavailable", () => {
		vi.stubGlobal("window", { get localStorage() { throw new Error("blocked"); } });
		const receipts = createBrowserActivityReadState();
		receipts.markRead("session-a", "run-a");
		expect(receipts.hasRead("session-a", "run-a")).toBe(true);
		const failedWrites = new SessionActivityReadState({ getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } });
		failedWrites.markRead("session-a", "run-a");
		expect(failedWrites.hasRead("session-a", "run-a")).toBe(true);
	});
});
