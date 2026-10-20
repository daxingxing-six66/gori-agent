import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeWorkspaceEvents } from "../shared/events/workspace-events";

class TestSource extends EventTarget {
	static sources: TestSource[] = [];
	onopen: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	close = vi.fn();
	readonly url: string;
	constructor(url: string) { super(); this.url = url; TestSource.sources.push(this); }
	emit(type: string) { this.dispatchEvent(new MessageEvent(type, { data: "{}" })); }
}
const cleanups: (() => void)[] = [];
const subscribe = (topics: string[], events: Record<string, (event: Event) => void> = {}, workspaceId = "w", locale: "en-US" | "zh-CN" = "en-US") => {
	const cleanup = subscribeWorkspaceEvents({ workspaceId, locale, topics, events }); cleanups.push(cleanup); return cleanup;
};
afterEach(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); await Promise.resolve(); TestSource.sources = []; vi.unstubAllGlobals(); });

describe("shared Workspace event transport", () => {
	it("shares topics, keeps remaining consumers alive, and ignores old connections after reconfiguration", async () => {
		vi.stubGlobal("EventSource", TestSource);
		const onTask = vi.fn(); const onReady = vi.fn(); const onSession = vi.fn();
		const closeTask = subscribe(["diagnoses"], { "diagnose.task.updated": onTask, "stream.ready": onReady });
		subscribe(["sessions"], { "session.updated": onSession });
		await Promise.resolve();
		const first = TestSource.sources[0]!;
		expect(TestSource.sources).toHaveLength(1);
		first.emit("stream.ready"); first.emit("diagnose.task.updated"); first.emit("session.updated");
		expect(onTask).toHaveBeenCalledOnce(); expect(onSession).toHaveBeenCalledOnce(); expect(onReady).toHaveBeenCalledOnce();
		closeTask(); await Promise.resolve();
		expect(first.close).toHaveBeenCalledOnce();
		first.emit("session.updated"); first.emit("diagnose.task.updated");
		const second = TestSource.sources[1]!;
		expect(new URL(second.url).searchParams.get("topics")).toBe("sessions");
		second.emit("session.updated"); expect(onSession).toHaveBeenCalledTimes(2); expect(onTask).toHaveBeenCalledOnce();
	});
	it("delivers readiness to a late consumer without reconnecting and cleans up only after the last consumer", async () => {
		vi.stubGlobal("EventSource", TestSource);
		const closeFirst = subscribe(["diagnoses"]); await Promise.resolve();
		const source = TestSource.sources[0]!; source.emit("stream.ready");
		const ready = vi.fn(); const closeSecond = subscribe(["diagnoses"], { "stream.ready": ready }); await Promise.resolve();
		expect(ready).toHaveBeenCalledOnce(); expect(TestSource.sources).toHaveLength(1);
		closeFirst(); await Promise.resolve(); expect(source.close).not.toHaveBeenCalled();
		closeSecond(); closeSecond(); expect(source.close).toHaveBeenCalledOnce();
	});
	it("isolates Workspace and Locale and releases subscriptions removed before connecting", async () => {
		vi.stubGlobal("EventSource", TestSource);
		const cancel = subscribe(["monitoring"], {}, "cancelled"); cancel();
		subscribe(["sessions"], {}, "w", "en-US"); subscribe(["sessions"], {}, "w", "zh-CN"); subscribe(["sessions"], {}, "other");
		await Promise.resolve(); expect(TestSource.sources).toHaveLength(3);
	});
	it("isolates a failing consumer and recovers all remaining consumers on the next ready event", async () => {
		vi.stubGlobal("EventSource", TestSource);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const ready = vi.fn();
		subscribe(["sessions"], { "stream.ready": () => { throw new Error("broken consumer"); } });
		subscribe(["sessions"], { "stream.ready": ready }); await Promise.resolve();
		const source = TestSource.sources[0]!; source.emit("stream.ready"); source.onerror?.(new Event("error")); source.emit("stream.ready");
		expect(ready).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledTimes(2); log.mockRestore();
	});
});
