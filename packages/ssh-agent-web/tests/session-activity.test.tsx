import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActivityGlyph } from "../features/session-activity/components/session-activity-indicator";
import { parseActivitySnapshot, parseActivityUpdate, type SessionActivity, type SessionActivityDisplayState } from "../features/session-activity/model/session-activity";
import { SessionActivityConnection } from "../features/session-activity/runtime/session-activity-connection";
import { SessionActivityStore } from "../features/session-activity/runtime/session-activity-store";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

const activity: SessionActivity = { runId: "run-a", sessionId: "session-a", workspaceId: "workspace-a", state: "running" };

class FakeEventSource {
	onerror: EventSource["onerror"] = null;
	readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>();
	close = vi.fn();
	addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
	emit(type: string, data: unknown, raw = false) {
		const event = new MessageEvent(type, { data: raw ? data : JSON.stringify(data) });
		for (const listener of this.listeners.get(type) ?? []) {
			if (typeof listener === "function") listener(event); else listener.handleEvent(event);
		}
	}
	error() { this.onerror?.call(this as unknown as EventSource, new Event("error")); }
}

describe("session activity state", () => {
	it("validates snapshots, update identities and supported states", () => {
		expect(parseActivitySnapshot({ activities: [activity] })).toEqual([activity]);
		expect(parseActivityUpdate({ sessionId: "session-a", runId: "run-a", activity })).toMatchObject({ activity });
		for (const state of ["completed", "failed", "cancelled"]) expect(parseActivitySnapshot({ activities: [{ ...activity, state }] })).not.toBeNull();
		for (const value of [null, [], {}, { activities: [activity, activity] }, { activities: [{ ...activity, state: "invalid" }] }, { activities: [{ ...activity, runId: "" }] }]) {
			expect(parseActivitySnapshot(value)).toBeNull();
		}
		for (const value of [{ sessionId: "other", runId: "run-a", activity }, { sessionId: "session-a", runId: "other", activity }, { sessionId: "session-a", runId: "run-a" }]) {
			expect(parseActivityUpdate(value)).toBeNull();
		}
	});

	it("isolates sessions and ignores old terminal updates after a replacement Run starts", () => {
		const store = new SessionActivityStore();
		store.applySnapshot([activity, { ...activity, sessionId: "session-b", runId: "run-b", state: "waiting_approval" }]);
		store.applyUpdate({ sessionId: "session-a", runId: "new", activity: { ...activity, runId: "new", state: "waiting_input" } });
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: null });
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: { ...activity, state: "completed" } });
		expect(store.state("session-a")).toBe("waiting_input");
		expect(store.state("session-b")).toBe("waiting_approval");
		store.applyUpdate({ sessionId: "session-a", runId: "new", activity: null });
		expect(store.state("session-a")).toBe("idle");
		expect(store.state("session-b")).toBe("waiting_approval");
	});

	it("uses unknown while disconnected and replaces all stale state on recovery", () => {
		const store = new SessionActivityStore(), listener = vi.fn();
		const unsubscribe = store.subscribe("session-a", listener);
		store.applySnapshot([activity]);
		store.disconnect();
		expect(store.state("session-a")).toBe("unknown");
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: null });
		expect(store.state("session-a")).toBe("unknown");
		store.applySnapshot([]);
		expect(store.state("session-a")).toBe("idle");
		expect(listener).toHaveBeenCalledTimes(3);
		unsubscribe(); store.disconnect();
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it("notifies only the target session and leaves idle and completed siblings unchanged", () => {
		const store = new SessionActivityStore();
		const listeners = Array.from({ length: 5 }, () => vi.fn());
		const ids = listeners.map((_, i) => `session-${i}`);
		store.applySnapshot([{ ...activity, sessionId: ids[1]!, runId: "completed-before", state: "completed" }]);
		const stop = ids.map((id, i) => store.subscribe(id, listeners[i]!));
		const target = { ...activity, sessionId: ids[2]! };
		for (const state of ["running", "waiting_approval", "running", "completed"] as const) {
			store.applyUpdate({ sessionId: target.sessionId, runId: target.runId, activity: { ...target, state } });
		}
		expect(listeners.map((listener) => listener.mock.calls.length)).toEqual([0, 0, 4, 0, 0]);
		expect(ids.map((id) => store.state(id))).toEqual(["idle", "completed", "completed", "idle", "idle"]);
		// Identical reconnection snapshots and duplicate terminal events do not notify other rows.
		store.applySnapshot([{ ...activity, sessionId: ids[1]!, runId: "completed-before", state: "completed" }, { ...target, state: "completed" }]);
		store.applyUpdate({ sessionId: target.sessionId, runId: target.runId, activity: { ...target, state: "completed" } });
		expect(listeners.map((listener) => listener.mock.calls.length)).toEqual([0, 0, 4, 0, 0]);
		stop.forEach((unsubscribe) => unsubscribe());
	});

	it("keeps unsubscribe idempotent across a new subscription for the same session", () => {
		const store = new SessionActivityStore(), old = vi.fn(), current = vi.fn();
		const stop = store.subscribe("session-a", old);
		stop();
		const stopCurrent = store.subscribe("session-a", current);
		stop();
		store.applySnapshot([activity]);
		expect(old).not.toHaveBeenCalled();
		expect(current).toHaveBeenCalledOnce();
		stopCurrent();
	});

	it.each(["completed", "failed", "cancelled"] as const)("acknowledges only the selected session's %s result across updates and snapshots", (state) => {
		const store = new SessionActivityStore();
		const result = { ...activity, state };
		const other = { ...result, sessionId: "session-b", runId: "run-b" };
		store.applySnapshot([result, other]);
		const targetListener = vi.fn(), otherListener = vi.fn();
		store.subscribe("session-a", targetListener);
		store.subscribe("session-b", otherListener);
		store.acknowledge("session-a");
		expect(store.state("session-a")).toBe("idle");
		expect(store.state("session-b")).toBe(state);
		store.acknowledge("session-a");
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: result });
		store.applySnapshot([result, other]);
		expect(store.state("session-a")).toBe("idle");
		expect(targetListener).toHaveBeenCalledOnce();
		expect(otherListener).not.toHaveBeenCalled();
		store.disconnect();
		store.applySnapshot([result, other]);
		expect(store.state("session-a")).toBe("idle");
	});

	it("shows a new Run's result after acknowledging the previous Run", () => {
		const store = new SessionActivityStore();
		store.applySnapshot([{ ...activity, state: "completed" }]);
		store.acknowledge("session-a");
		const next = { ...activity, runId: "next" };
		store.applyUpdate({ sessionId: "session-a", runId: "next", activity: next });
		expect(store.state("session-a")).toBe("running");
		store.applyUpdate({ sessionId: "session-a", runId: "next", activity: { ...next, state: "failed" } });
		expect(store.state("session-a")).toBe("failed");
	});

	it("automatically reads the viewed session's completion before notifying its row", () => {
		const store = new SessionActivityStore();
		const sibling = { ...activity, sessionId: "session-b", runId: "run-b" };
		store.setViewedSession("session-a");
		store.applySnapshot([activity, sibling]);
		const states: SessionActivityDisplayState[] = [], otherListener = vi.fn();
		store.subscribe("session-a", () => states.push(store.state("session-a")));
		store.subscribe("session-b", otherListener);
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: { ...activity, state: "completed" } });
		expect(states).toEqual(["idle"]);
		expect(store.state("session-b")).toBe("running");
		expect(otherListener).not.toHaveBeenCalled();
		store.applyUpdate({ sessionId: "session-b", runId: "run-b", activity: { ...sibling, state: "completed" } });
		expect(store.state("session-b")).toBe("completed");
		store.setViewedSession(null);
		store.applySnapshot([{ ...activity, state: "completed" }, { ...sibling, state: "completed" }]);
		expect(store.state("session-a")).toBe("idle");
		expect(store.state("session-b")).toBe("completed");
	});

	it("reads a completion arriving in the first or a reconnected snapshot of the viewed session", () => {
		const store = new SessionActivityStore();
		const result = { ...activity, state: "completed" as const };
		store.setViewedSession("session-a");
		store.applySnapshot([result]);
		expect(store.state("session-a")).toBe("idle");
		store.disconnect();
		store.applySnapshot([{ ...result, runId: "next" }]);
		expect(store.state("session-a")).toBe("idle");
		store.setViewedSession(null);
		store.disconnect();
		store.applySnapshot([{ ...result, runId: "unviewed" }]);
		expect(store.state("session-a")).toBe("completed");
		store.setViewedSession("session-a");
		expect(store.state("session-a")).toBe("idle");
	});

	it("keeps results unread when the user leaves before completion, including a new Run", () => {
		const store = new SessionActivityStore();
		store.applySnapshot([activity]);
		store.setViewedSession("session-a");
		store.setViewedSession("session-b");
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: { ...activity, state: "completed" } });
		expect(store.state("session-a")).toBe("completed");
		store.setViewedSession("session-a");
		expect(store.state("session-a")).toBe("idle");
		const next = { ...activity, runId: "next" };
		store.applyUpdate({ sessionId: "session-a", runId: "next", activity: next });
		expect(store.state("session-a")).toBe("running");
		store.setViewedSession(null);
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: { ...activity, state: "completed" } });
		expect(store.state("session-a")).toBe("running");
		store.applyUpdate({ sessionId: "session-a", runId: "next", activity: { ...next, state: "completed" } });
		expect(store.state("session-a")).toBe("completed");
	});

	it.each(["running", "waiting_approval", "waiting_input", "attention", "failed", "cancelled"] as const)("keeps %s visible while the session is being viewed", (state) => {
		const store = new SessionActivityStore();
		store.setViewedSession("session-a");
		store.applySnapshot([{ ...activity, state }]);
		expect(store.state("session-a")).toBe(state);
		store.setViewedSession(null);
		store.setViewedSession("session-a");
		expect(store.state("session-a")).toBe(state);
	});

	it.each(["running", "waiting_approval", "waiting_input", "attention"] as const)("does not dismiss an unresolved %s state when entering the session", (state) => {
		const store = new SessionActivityStore();
		store.applySnapshot([{ ...activity, state }]);
		const listener = vi.fn();
		store.subscribe("session-a", listener);
		store.acknowledge("session-a");
		expect(store.state("session-a")).toBe(state);
		expect(listener).not.toHaveBeenCalled();
		store.applyUpdate({ sessionId: "session-a", runId: "run-a", activity: { ...activity, state: "completed" } });
		expect(store.state("session-a")).toBe("completed");
	});
});

describe("one shared activity connection", () => {
	afterEach(() => vi.useRealTimers());
	function fixture() {
		vi.useFakeTimers();
		const store = new SessionActivityStore(), sources: FakeEventSource[] = [];
		const create = vi.fn(() => { const source = new FakeEventSource(); sources.push(source); return source; });
		const connection = new SessionActivityConnection(store, create);
		return { store, sources, create, connection };
	}

	it("creates one stream, requires a snapshot, and updates sessions without reconnecting", () => {
		const f = fixture();
		try {
			f.connection.start(); f.connection.start();
			expect(f.create).toHaveBeenCalledOnce();
			expect(f.create.mock.calls[0]).toEqual([expect.stringContaining("/api/session-activity/events")]);
			expect(f.store.state("session-a")).toBe("unknown");
			f.sources[0]!.emit("activity.snapshot", { activities: [activity] });
			expect(f.store.state("session-a")).toBe("running");
			f.sources[0]!.emit("activity.updated", { sessionId: "session-a", runId: "run-a", activity: { ...activity, state: "waiting_input" } });
			expect(f.store.state("session-a")).toBe("waiting_input");
			expect(f.create).toHaveBeenCalledOnce();
		} finally { f.connection.stop(); }
	});

	it("reconnects after errors, discards old-source callbacks and restores completed sessions from a snapshot", async () => {
		const f = fixture();
		try {
			f.connection.start();
			const old = f.sources[0]!;
			old.emit("activity.snapshot", { activities: [activity] });
			old.error();
			expect(old.close).toHaveBeenCalledOnce();
			expect(f.store.state("session-a")).toBe("unknown");
			await vi.advanceTimersByTimeAsync(1000);
			old.emit("activity.snapshot", { activities: [activity] });
			expect(f.store.state("session-a")).toBe("unknown");
			f.sources[1]!.emit("activity.snapshot", { activities: [] });
			expect(f.store.state("session-a")).toBe("idle");
		} finally { f.connection.stop(); }
	});

	it.each(["malformed", "missing snapshot", "invalid identity"])("recovers %s protocol data and stops all retry work on cleanup", async (kind) => {
		const f = fixture();
		f.connection.start();
		if (kind === "malformed") f.sources[0]!.emit("activity.snapshot", "{broken", true);
		if (kind === "missing snapshot") f.sources[0]!.emit("activity.updated", { sessionId: "session-a", runId: "run-a", activity });
		if (kind === "invalid identity") {
			f.sources[0]!.emit("activity.snapshot", { activities: [activity] });
			f.sources[0]!.emit("activity.updated", { sessionId: "other", runId: "run-a", activity });
		}
		expect(f.sources[0]!.close).toHaveBeenCalledOnce();
		f.connection.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.sources).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("allows setup-cleanup-setup and bounds repeated reconnect attempts", async () => {
		const f = fixture();
		try {
			f.connection.start(); f.connection.stop(); f.connection.start();
			expect(f.sources).toHaveLength(2);
			for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
				const count = f.sources.length;
				f.sources.at(-1)!.error();
				await vi.advanceTimersByTimeAsync(delay - 1);
				expect(f.sources).toHaveLength(count);
				await vi.advanceTimersByTimeAsync(1);
				expect(f.sources).toHaveLength(count + 1);
			}
		} finally { f.connection.stop(); }
	});
});

describe("sidebar activity indicator", () => {
	it("provides distinct localized labels and icons for active and terminal states", () => {
		const states: SessionActivityDisplayState[] = ["running", "waiting_approval", "waiting_input", "attention", "completed", "failed", "cancelled", "idle", "unknown"];
		for (const [locale, messages] of [["zh-CN", zhCNMessages], ["en-US", enUSMessages]] as const) {
			for (const state of states) {
				const html = renderToStaticMarkup(createElement(IntlProvider, { locale, messages }, createElement(SessionActivityGlyph, { state, active: true })));
				expect(html).toContain(`aria-label="${messages[`sessionActivity.${state}`]}"`);
				expect(html).toContain(`session-activity-${state}`);
				if (state === "idle") { expect(html).toContain("session-activity-dot"); expect(html).toContain("<circle"); expect(html).not.toContain("session-activity-running"); }
			}
		}
	});
});
