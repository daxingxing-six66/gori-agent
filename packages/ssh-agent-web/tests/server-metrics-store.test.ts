import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerMetricsStore } from "../features/server-metrics/runtime/server-metrics-store";
import type { ServerMetricsStreamOptions } from "../features/server-metrics/runtime/server-metrics-stream";
import { parseServerMetricsSnapshot, type ServerMetricsSnapshot } from "../features/server-metrics/model/server-metrics";

function snapshot(workspaceId = "ws", sampledAt = Date.now()): ServerMetricsSnapshot {
	return { workspaceId, sampledAt, cpu: { usagePercent: 3.4 },
		memory: { usedBytes: 100, totalBytes: 200, usagePercent: 50 },
		diskIo: { readBytesPerSecond: 2048, writeBytesPerSecond: 4096 },
		network: { interfaceName: "eth0", receiveBytesPerSecond: 1024, transmitBytesPerSecond: 512 } };
}

function fixture() {
	const connections: ServerMetricsStreamOptions[] = [];
	const close = vi.fn();
	const open = vi.fn((options: ServerMetricsStreamOptions) => { connections.push(options); return close; });
	return { store: createServerMetricsStore(open), connections, open, close };
}

describe("session server metrics cache", () => {
	beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T00:00:00Z")); });
	afterEach(() => vi.useRealTimers());

	it("shares one stream for multiple sessions and closes it only after the final consumer", () => {
		const { store, connections, open, close } = fixture();
		const resource = store.resource("ws", "zh-CN");
		expect(store.resource("ws", "zh-CN")).toBe(resource);
		const first = vi.fn();
		const second = vi.fn();
		const leaveFirst = resource.subscribe(first);
		const leaveSecond = resource.subscribe(second);
		expect(open).toHaveBeenCalledTimes(1);
		connections[0].onSnapshot(snapshot());
		expect(resource.getSnapshot().status).toBe("live");
		expect(resource.getSnapshot().snapshot?.diskIo).toEqual({ readBytesPerSecond: 2048, writeBytesPerSecond: 4096 });
		expect(first).toHaveBeenCalled();
		expect(second).toHaveBeenCalled();
		leaveFirst();
		expect(close).not.toHaveBeenCalled();
		leaveSecond();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("reuses a recent snapshot after navigation but ignores callbacks from the closed stream", () => {
		const { store, connections } = fixture();
		const resource = store.resource("ws", "zh-CN");
		const leave = resource.subscribe(() => {});
		connections[0].onSnapshot(snapshot());
		leave();
		expect(store.resource("ws", "zh-CN").getSnapshot().snapshot?.cpu.usagePercent).toBe(3.4);
		expect(store.resource("ws", "zh-CN").getSnapshot().snapshot?.diskIo?.writeBytesPerSecond).toBe(4096);
		const leaveAgain = resource.subscribe(() => {});
		connections[0].onSnapshot({ ...snapshot(), cpu: { usagePercent: 99 } });
		expect(resource.getSnapshot().snapshot?.cpu.usagePercent).toBe(3.4);
		connections[1].onSnapshot({ ...snapshot(), cpu: { usagePercent: 12 } });
		expect(resource.getSnapshot().snapshot?.cpu.usagePercent).toBe(12);
		leaveAgain();
	});

	it("isolates workspaces and locales and refuses foreign or older snapshots", () => {
		const { store, connections, open } = fixture();
		const first = store.resource("ws", "zh-CN");
		const other = store.resource("other", "zh-CN");
		const english = store.resource("ws", "en-US");
		const leaves = [first, other, english].map((resource) => resource.subscribe(() => {}));
		expect(open).toHaveBeenCalledTimes(3);
		connections[0].onSnapshot(snapshot());
		connections[0].onSnapshot(snapshot("other"));
		connections[0].onSnapshot({ ...snapshot("ws", Date.now() - 1), cpu: { usagePercent: 99 } });
		expect(first.getSnapshot().snapshot?.cpu.usagePercent).toBe(3.4);
		expect(other.getSnapshot().snapshot).toBeUndefined();
		expect(english.getSnapshot().snapshot).toBeUndefined();
		leaves.forEach((leave) => leave());
	});

	it("marks failures, reconnections and stale samples while retaining the last data", async () => {
		const { store, connections } = fixture();
		const resource = store.resource("ws", "zh-CN");
		const leave = resource.subscribe(() => {});
		const connection = connections[0];
		connection.onConnection(false);
		expect(resource.getSnapshot().status).toBe("reconnecting");
		connection.onSnapshot(snapshot());
		await vi.advanceTimersByTimeAsync(12_000);
		expect(resource.getSnapshot().status).toBe("stale");
		connection.onError("collection failed");
		expect(resource.getSnapshot()).toMatchObject({ status: "unavailable", error: "collection failed" });
		expect(resource.getSnapshot().snapshot).toBeDefined();
		connection.onConnection(true);
		expect(resource.getSnapshot().status).toBe("unavailable");
		connection.onSnapshot(snapshot());
		expect(resource.getSnapshot().status).toBe("live");
		expect(resource.getSnapshot().error).toBeUndefined();
		leave();
	});

	it("expires unused resources and never labels an old replay as live", async () => {
		const { store, connections } = fixture();
		const resource = store.resource("ws", "zh-CN");
		const leave = resource.subscribe(() => {});
		connections[0].onSnapshot(snapshot("ws", Date.now() - 60_000));
		expect(resource.getSnapshot().status).toBe("stale");
		leave();
		await vi.advanceTimersByTimeAsync(30_000);
		const fresh = store.resource("ws", "zh-CN");
		expect(fresh).not.toBe(resource);
		expect(fresh.getSnapshot().snapshot).toBeUndefined();
	});
});

describe("server metrics event projection", () => {
	it("preserves disk rates, zero values and nullable baselines while accepting older snapshots", () => {
		expect(parseServerMetricsSnapshot(snapshot())?.diskIo).toEqual({ readBytesPerSecond: 2048, writeBytesPerSecond: 4096 });
		expect(parseServerMetricsSnapshot({ ...snapshot(), diskIo: { readBytesPerSecond: 0, writeBytesPerSecond: 0 } })?.diskIo)
			.toEqual({ readBytesPerSecond: 0, writeBytesPerSecond: 0 });
		expect(parseServerMetricsSnapshot({ ...snapshot(), diskIo: { readBytesPerSecond: null, writeBytesPerSecond: null } })?.diskIo)
			.toEqual({ readBytesPerSecond: null, writeBytesPerSecond: null });
		expect(parseServerMetricsSnapshot({ ...snapshot(), diskIo: undefined })?.diskIo).toBeUndefined();
	});

	it.each([null, [], "invalid", { readBytesPerSecond: 1 },
		{ readBytesPerSecond: -1, writeBytesPerSecond: 0 }, { readBytesPerSecond: 0, writeBytesPerSecond: Infinity },
		{ readBytesPerSecond: NaN, writeBytesPerSecond: null }, { readBytesPerSecond: "1024", writeBytesPerSecond: 1 },
	])("drops invalid optional disk statistics without losing other resource metrics: %j", (diskIo) => {
		const parsed = parseServerMetricsSnapshot({ ...snapshot(), diskIo });
		expect(parsed?.diskIo).toBeUndefined();
		expect(parsed?.cpu.usagePercent).toBe(3.4);
		expect(parsed?.memory.usagePercent).toBe(50);
		expect(parsed?.network?.receiveBytesPerSecond).toBe(1024);
	});

	it("accepts older snapshots without network metrics and drops malformed network data", () => {
		const old = { ...snapshot(), network: undefined };
		expect(parseServerMetricsSnapshot(old)?.network).toBeUndefined();
		expect(parseServerMetricsSnapshot({ ...old, network: { interfaceName: "eth0", receiveBytesPerSecond: -1 } })?.cpu.usagePercent).toBe(3.4);
		expect(parseServerMetricsSnapshot({ ...snapshot(), network: { interfaceName: "eth0", receiveBytesPerSecond: null, transmitBytesPerSecond: null } })?.network?.receiveBytesPerSecond).toBeNull();
	});

	it.each([undefined, { ...snapshot(), sampledAt: NaN }, { ...snapshot(), cpu: { usagePercent: Infinity } },
		{ ...snapshot(), memory: { usagePercent: -1 } }])("rejects malformed base metrics", (value) => {
		expect(parseServerMetricsSnapshot(value)).toBeUndefined();
	});
});
