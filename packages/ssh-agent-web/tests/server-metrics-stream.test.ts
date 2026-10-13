import { afterEach, describe, expect, it, vi } from "vitest";
import { openServerMetricsStream } from "../features/server-metrics/runtime/server-metrics-stream";

class TestEventSource extends EventTarget {
	static latest: TestEventSource;
	readonly url: string;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	close = vi.fn();
	constructor(url: string) {
		super();
		this.url = url;
		TestEventSource.latest = this;
	}
	emit(type: string, data: string) {
		this.dispatchEvent(new MessageEvent(type, { data }));
	}
}

describe("server metrics EventSource adapter", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("subscribes only to monitoring and ignores malformed or foreign events", () => {
		vi.stubGlobal("EventSource", TestEventSource);
		const onSnapshot = vi.fn();
		const onConnection = vi.fn();
		const onError = vi.fn();
		const close = openServerMetricsStream({ workspaceId: "ws/one", locale: "en-US", onSnapshot, onConnection, onError });
		const source = TestEventSource.latest;
		expect(source.url).toContain("/api/workspaces/ws%2Fone/events?topics=monitoring&locale=en-US");
		const snapshot = { workspaceId: "ws/one", sampledAt: 1000, cpu: { usagePercent: 3.4 },
			memory: { usedBytes: 50, totalBytes: 100, usagePercent: 50 } };
		source.emit("monitor.snapshot", "invalid");
		source.emit("monitor.snapshot", JSON.stringify({ ...snapshot, workspaceId: "other" }));
		expect(onSnapshot).not.toHaveBeenCalled();
		source.emit("monitor.snapshot", JSON.stringify(snapshot));
		expect(onSnapshot).toHaveBeenCalledWith(snapshot);
		source.onopen?.();
		source.onerror?.();
		expect(onConnection.mock.calls).toEqual([[true], [false]]);
		source.emit("monitor.error", JSON.stringify({ message: "Collection failed" }));
		expect(onError).toHaveBeenCalledWith("Collection failed");
		close();
		source.emit("monitor.snapshot", JSON.stringify(snapshot));
		expect(onSnapshot).toHaveBeenCalledTimes(1);
		expect(source.onopen).toBeNull();
		expect(source.onerror).toBeNull();
		expect(source.close).toHaveBeenCalledTimes(1);
	});
});
