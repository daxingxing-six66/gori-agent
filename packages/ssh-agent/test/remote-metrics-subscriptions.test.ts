import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteMetricsService, REMOTE_METRICS_BASE_COMMAND } from "../src/application/services/remote-metrics-service.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import type { ExecuteRemoteCommandInput } from "../src/application/ssh-channel-broker.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target: SshTargetSnapshot = {
	workspaceId: "ws", workspaceRevision: 1, hostname: "server.test", port: 22,
	hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "test", credentialId: "credential",
	credentialAuthVersion: 1, remoteUser: "user", defaultCwd: "/", connectTimeoutMs: 1000,
	keepaliveIntervalMs: 1000, keepaliveMaxCount: 3,
};

function fixture() {
	const events = new WorkspaceEventHub();
	let sample = 0;
	const execute = vi.fn(async (input: ExecuteRemoteCommandInput) => {
		if (input.command === REMOTE_METRICS_BASE_COMMAND) {
			sample++;
			await input.onStdout(Buffer.from(`CORES 4\nCPU ${sample * 100} 0 0 800 0 0 0 0\nMEM 8000 3000\n` +
				`UP ${100 + sample * 2}\nNET_TIME ${100 + sample * 2}\nNET eth0 ${sample * 2048} ${sample * 1024}\nNET_ROUTE4 eth0 00000000 0003 0\n`));
		}
		return { exitCode: 0 };
	});
	const service = new RemoteMetricsService({
		events, targets: { resolveWorkspace: async (workspaceId) => ({ ...target, workspaceId }) },
		broker: { execute, snapshotWorkspace: (workspaceId) => ({ workspaceId, state: "connected", activeChannels: 0, waitingChannels: 0, generation: 1 }) },
	});
	return { events, service, execute };
}

describe("shared remote metrics subscriptions", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("replays the cache only to a new monitoring subscriber without another remote probe", async () => {
		const { events, service, execute } = fixture();
		const first = events.subscribe("ws", new Set(["monitoring"])).getReader();
		await vi.advanceTimersByTimeAsync(0);
		await first.read(); // stream.ready
		await first.read(); // initial sample
		expect(execute).toHaveBeenCalledTimes(2); // base and process
		let replayedToFirst = false;
		const firstNext = first.read().then(() => { replayedToFirst = true; });
		const second = events.subscribe("ws", new Set(["monitoring"])).getReader();
		await second.read();
		const cached = new TextDecoder().decode((await second.read()).value);
		expect(cached).toContain("event: monitor.snapshot");
		expect(cached).toContain(JSON.stringify(service.latest("ws")));
		expect(execute).toHaveBeenCalledTimes(2);
		expect(replayedToFirst).toBe(false);
		await first.cancel();
		await firstNext;
		await second.cancel();
		service.close();
		events.close();
	});

	it("shares sampling, releases the collector after the last subscriber, and starts a fresh baseline", async () => {
		const { events, service, execute } = fixture();
		const first = events.subscribe("ws", new Set(["monitoring"])).getReader();
		const second = events.subscribe("ws", new Set(["monitoring"])).getReader();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(execute).toHaveBeenCalledTimes(3);
		expect(service.latest("ws")?.network).toMatchObject({ receiveBytesPerSecond: 1024, transmitBytesPerSecond: 512 });
		await first.cancel();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(service.latest("ws")).toBeDefined();
		await second.cancel();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(service.latest("ws")).toBeUndefined();
		const callsAfterStop = execute.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(execute).toHaveBeenCalledTimes(callsAfterStop);
		const third = events.subscribe("ws", new Set(["monitoring"])).getReader();
		await vi.advanceTimersByTimeAsync(0);
		expect(service.latest("ws")?.network?.receiveBytesPerSecond).toBeNull();
		await third.cancel();
		service.close();
		events.close();
	});

	it("does not activate monitoring for unrelated topics or another workspace", async () => {
		const { events, service, execute } = fixture();
		const unrelated = events.subscribe("ws", new Set(["sessions"])).getReader();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(execute).not.toHaveBeenCalled();
		const monitored = events.subscribe("other", new Set(["monitoring"])).getReader();
		await vi.advanceTimersByTimeAsync(0);
		expect(service.latest("ws")).toBeUndefined();
		expect(service.latest("other")?.workspaceId).toBe("other");
		await unrelated.cancel();
		await monitored.cancel();
		service.close();
		events.close();
	});

	it("does not publish a late sample or launch a process probe after service shutdown", async () => {
		const { events, service, execute } = fixture();
		let finishProbe: (() => void) | undefined;
		execute.mockImplementationOnce(async (input) => {
			await new Promise<void>((resolve) => { finishProbe = resolve; });
			await input.onStdout(Buffer.from("CORES 4\nCPU 100 0 0 800\nMEM 8000 3000\n"));
			return { exitCode: 0 };
		});
		const reader = events.subscribe("ws", new Set(["monitoring"])).getReader();
		await reader.read();
		await vi.advanceTimersByTimeAsync(0);
		service.close();
		finishProbe?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(service.latest("ws")).toBeUndefined();
		await reader.cancel();
		events.close();
	});
});
