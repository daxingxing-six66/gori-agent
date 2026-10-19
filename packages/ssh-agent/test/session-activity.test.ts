import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRunEventHub } from "../src/application/chat-run-event-hub.ts";
import { SessionActivityProjector } from "../src/application/session-activity/session-activity-projector.ts";
import { SessionActivityService } from "../src/application/session-activity/session-activity-service.ts";
import { SessionActivityStream } from "../src/application/session-activity/session-activity-stream.ts";
import type { SessionActivity } from "../src/domain/session-activity.ts";

const run = (id = "run-a", sessionId = "session-a", status = "running", createdAt = 1) =>
	({ id, sessionId, workspaceId: "workspace", status, createdAt });
const activity: SessionActivity = { runId: "run-a", sessionId: "session-a", workspaceId: "workspace", state: "running" };
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

describe("session activity projection", () => {
	it("tracks independent sessions and ignores token, tool and queue traffic", () => {
		const projector = new SessionActivityProjector();
		expect(projector.apply({ runId: "run-a", type: "run.updated", data: run() })?.activity).toEqual(activity);
		projector.apply({ runId: "run-b", type: "run.updated", data: run("run-b", "session-b", "pending") });
		for (const type of ["message_update", "tool_execution_start", "tool_execution_end", "queue.consumed"]) {
			expect(projector.apply({ runId: "run-a", type, data: {} })).toBeNull();
		}
		expect(projector.snapshot()).toHaveLength(2);
		// pending -> running is the same visible state, without redundant broadcasts.
		expect(projector.apply({ runId: "run-b", type: "run.updated", data: run("run-b", "session-b") })).toBeNull();
	});

	it("counts parallel waits, deduplicates events and restores the next remaining reason", () => {
		const p = new SessionActivityProjector();
		p.apply({ runId: "run-a", type: "run.updated", data: run() });
		const wait = (type: string, id: string, status: string) => p.apply({ runId: "run-a", type, data: { id, runId: "run-a", sessionId: "session-a", status } });
		expect(wait("approval.resolved", "auto", "approved")).toBeNull();
		expect(wait("approval.requested", "one", "pending")?.activity?.state).toBe("waiting_approval");
		expect(wait("approval.requested", "one", "pending")).toBeNull();
		wait("approval.requested", "two", "pending");
		expect(wait("approval.resolved", "one", "approved")).toBeNull();
		expect(wait("decision.requested", "question", "pending")?.activity?.state).toBe("waiting_input");
		expect(wait("decision.resolved", "question", "answered")?.activity?.state).toBe("waiting_approval");
		expect(wait("approval.resolved", "two", "rejected")?.activity?.state).toBe("running");
		expect(wait("approval.resolved", "two", "rejected")).toBeNull();
	});

	it.each(["completed", "cancelled", "failed"])("retains the %s result and releases active waits", (status) => {
		const p = new SessionActivityProjector();
		p.apply({ runId: "run-a", type: "run.updated", data: run() });
		p.apply({ runId: "run-a", type: "approval.requested", data: { id: "wait", runId: "run-a", sessionId: "session-a", status: "pending" } });
		expect(p.apply({ runId: "run-a", type: "run.updated", data: run("run-a", "session-a", status) }))
			.toEqual({ sessionId: "session-a", runId: "run-a", activity: { ...activity, state: status } });
		expect(p.apply({ runId: "run-a", type: "approval.resolved", data: { id: "wait", runId: "run-a", sessionId: "session-a", status: "rejected" } })).toBeNull();
		expect(p.snapshot()).toEqual([{ ...activity, state: status }]);
		expect(p.apply({ runId: "run-a", type: "run.updated", data: run() })).toBeNull();
	});

	it("does not let old Run events clear a replacement Run or mix session waits", () => {
		const p = new SessionActivityProjector();
		p.apply({ runId: "old", type: "run.updated", data: run("old") });
		p.apply({ runId: "new", type: "run.updated", data: run("new", "session-a", "running", 2) });
		for (const status of ["running", "completed"]) expect(p.apply({ runId: "old", type: "run.updated", data: run("old", "session-a", status) })).toBeNull();
		expect(p.apply({ runId: "new", type: "decision.requested", data: { id: "other", runId: "new", sessionId: "session-b", status: "pending" } })).toBeNull();
		expect(p.snapshot()).toEqual([{ ...activity, runId: "new" }]);
	});

	it("shows unresolved final persistence as needing recovery, then clears after the commit succeeds", () => {
		const p = new SessionActivityProjector();
		p.apply({ runId: "run-a", type: "run.updated", data: run() });
		expect(p.apply({ runId: "run-a", type: "run.persistence_failed", data: { runId: "run-a" } })?.activity?.state).toBe("attention");
		p.apply({ runId: "run-a", type: "run.updated", data: run("run-a", "session-a", "completed") });
		expect(p.snapshot()).toEqual([{ ...activity, state: "completed" }]);
	});

	it("changes only the observed session and does not backfill unrelated historical results", () => {
		const p = new SessionActivityProjector();
		for (let i = 0; i < 5; i++) {
			expect(p.apply({ runId: `old-${i}`, type: "run.updated", data: run(`old-${i}`, `session-${i}`, "completed") })).toBeNull();
		}
		expect(p.snapshot()).toEqual([]);
		p.apply({ runId: "new", type: "run.updated", data: run("new", "session-2", "running", 2) });
		p.apply({ runId: "new", type: "run.updated", data: run("new", "session-2", "completed", 2) });
		expect(p.snapshot()).toEqual([{ ...activity, sessionId: "session-2", runId: "new", state: "completed" }]);
		expect(p.apply({ runId: "old-2", type: "run.updated", data: run("old-2", "session-2") })).toBeNull();
	});

	it("bounds retained results and replaces only the session that starts a new Run", () => {
		const p = new SessionActivityProjector();
		for (let i = 0; i < 300; i++) {
			p.apply({ runId: `run-${i}`, type: "run.updated", data: run(`run-${i}`, `session-${i}`) });
			p.apply({ runId: `run-${i}`, type: "run.updated", data: run(`run-${i}`, `session-${i}`, "completed") });
		}
		expect(p.snapshot()).toHaveLength(256);
		expect(p.snapshot().some((entry) => entry.sessionId === "session-0")).toBe(false);
		p.apply({ runId: "latest", type: "run.updated", data: run("latest", "session-299", "running", 2) });
		expect(p.snapshot().filter((entry) => entry.sessionId === "session-299")).toEqual([{ ...activity, runId: "latest", sessionId: "session-299" }]);
	});

	it("rejects invalid identities and snapshots cannot mutate projection state", () => {
		const p = new SessionActivityProjector();
		for (const data of [null, [], {}, { ...run(), id: "wrong" }, { ...run(), createdAt: NaN }, { ...run(), status: "invalid" }]) {
			expect(p.apply({ runId: "run-a", type: "run.updated", data })).toBeNull();
		}
		p.apply({ runId: "run-a", type: "run.updated", data: run() });
		Object.assign(p.snapshot()[0]!, { state: "waiting_input" });
		expect(p.snapshot()).toEqual([activity]);
		p.clear(); expect(p.snapshot()).toEqual([]);
	});
});

describe("shared activity event delivery", () => {
	afterEach(() => vi.useRealTimers());
	it("starts every connection with the current snapshot and recovers events missed while disconnected", async () => {
		const hub = new ChatRunEventHub();
		const service = new SessionActivityService(hub);
		hub.publish("run-a", "run.updated", run());
		const first = service.subscribe().getReader();
		expect(decode((await first.read()).value)).toContain('"state":"running"');
		await first.cancel();
		hub.publish("run-a", "approval.requested", { id: "approval", runId: "run-a", sessionId: "session-a", status: "pending", description: "private command" });
		const next = service.subscribe().getReader();
		const snapshot = decode((await next.read()).value);
		expect(snapshot).toContain("event: activity.snapshot");
		expect(snapshot).toContain('"state":"waiting_approval"');
		expect(snapshot).not.toContain("private command");
		hub.publish("run-a", "run.updated", run("run-a", "session-a", "cancelled"));
		expect(decode((await next.read()).value)).toContain('"state":"cancelled"');
		service.close(); hub.close();
		expect((await next.read()).done).toBe(true);
	});

	it("unsubscribes observers and isolates projection delivery failures from Chat publishers", () => {
		const hub = new ChatRunEventHub();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const observer = vi.fn(() => { throw new Error("display delivery failed"); });
		const stop = hub.observe(["run.updated"], observer);
		try {
			hub.publish("run-a", "message_update", {});
			expect(observer).not.toHaveBeenCalled();
			expect(() => hub.publish("run-a", "run.updated", run())).not.toThrow();
			stop(); hub.publish("run-a", "run.updated", run());
			expect(observer).toHaveBeenCalledOnce();
		} finally { hub.close(); log.mockRestore(); }
	});

	it("cleans up heartbeat and abort listeners when the last browser leaves", async () => {
		vi.useFakeTimers();
		const stream = new SessionActivityStream(() => []);
		const abort = new AbortController();
		const reader = stream.subscribe(abort.signal).getReader();
		await reader.read();
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(decode((await reader.read()).value)).toBe(": heartbeat\n\n");
		abort.abort();
		expect((await reader.read()).done).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		stream.close();
		expect((await stream.subscribe().getReader().read()).done).toBe(true);
	});

	it("bounds slow subscriber queues instead of retaining an unbounded event backlog", async () => {
		const stream = new SessionActivityStream(() => []);
		const reader = stream.subscribe().getReader();
		for (let i = 0; i < 200; i++) stream.publish({ sessionId: "session-a", runId: "run-a", activity });
		let frames = 0;
		while (!(await reader.read()).done) frames++;
		expect(frames).toBeLessThanOrEqual(64);
		stream.close();
	});
});
