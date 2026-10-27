import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REMOTE_METRICS_BASE_COMMAND,
	REMOTE_METRICS_PROCESS_COMMAND,
	RemoteMetricsService,
} from "../src/application/services/remote-metrics-service.ts";
import type { ExecuteRemoteCommandInput } from "../src/application/ssh-channel-broker.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target: SshTargetSnapshot = {
	workspaceId: "ws", workspaceRevision: 1, hostname: "private-host-no-log.test", port: 22,
	hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "private-fingerprint-no-log",
	credentialId: "private-credential-no-log", credentialAuthVersion: 1, remoteUser: "private-user-no-log",
	connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3,
};
const baseOutput = "CORES 4\nCPU 100 0 0 800 0 0 0 0\nMEM 8000 3000\nUP 100\n";
const processOutput = "PROC 42 1 root S 12.5 4.2 1024 90 private-command-no-log private-command-no-log --private\n";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function fixture() {
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const events = new WorkspaceEventHub();
	const targets = { resolveWorkspace: vi.fn(async () => target) };
	const execute = vi.fn(async (input: ExecuteRemoteCommandInput) => {
		await input.onStdout(Buffer.from(input.command === REMOTE_METRICS_BASE_COMMAND ? baseOutput : processOutput));
		return { exitCode: 0 };
	});
	const service = new RemoteMetricsService({
		events, targets,
		broker: { execute, snapshotWorkspace: (workspaceId) => ({ workspaceId, state: "connected", activeChannels: 0,
			waitingChannels: 0, generation: 1 }) },
	});
	const subscribe = () => events.subscribe("ws", new Set(["monitoring"])).getReader();
	return { info, error, events, targets, execute, service, subscribe };
}

function diagnostics(info: ReturnType<typeof fixture>["info"], event: string) {
	return info.mock.calls.filter((call) => call[0] === "SSH Agent remote metrics diagnostics" && call[1]?.event === event)
		.map((call) => call[1]);
}

describe("remote metrics queue diagnostics", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("records old queued samples while preserving every timer tick and FIFO probe order", async () => {
		const f = fixture();
		const gate = deferred();
		f.execute.mockImplementationOnce(async (input) => {
			await gate.promise;
			await input.onStdout(Buffer.from(baseOutput));
			return { exitCode: 0 };
		});
		const reader = f.subscribe();
		await vi.advanceTimersByTimeAsync(7_000);
		expect(f.execute).toHaveBeenCalledTimes(1);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.execute.mock.calls.map(([input]) => input.command)).toEqual([
			REMOTE_METRICS_BASE_COMMAND, REMOTE_METRICS_PROCESS_COMMAND,
			REMOTE_METRICS_BASE_COMMAND,
			REMOTE_METRICS_BASE_COMMAND, REMOTE_METRICS_PROCESS_COMMAND,
			REMOTE_METRICS_BASE_COMMAND, REMOTE_METRICS_BASE_COMMAND,
			REMOTE_METRICS_BASE_COMMAND, REMOTE_METRICS_PROCESS_COMMAND,
		]);
		const started = diagnostics(f.info, "sample.started");
		const finished = diagnostics(f.info, "sample.finished");
		expect(started).toHaveLength(5);
		expect(finished).toHaveLength(6);
		expect(started.map((entry) => entry.queuedAt)).toEqual([2_000, 3_000, 4_000, 6_000, 6_000]);
		expect(started.map((entry) => entry.queueWaitMs)).toEqual([5_000, 4_000, 3_000, 1_000, 1_000]);
		expect(started.map((entry) => entry.includeProcesses)).toEqual([false, true, false, false, true]);
		expect(started.map((entry) => entry.trigger)).toEqual(["base_timer", "process_timer", "base_timer", "base_timer", "process_timer"]);
		expect(started[0]).toMatchObject({ workspaceId: "ws", startedAt: 7_000,
			queueDepthAtEnqueue: { waiting: 1, running: 1 }, queueDepthAtStart: { waiting: 4, running: 1 },
			queueDepth: { waiting: 4, running: 1 }, stage: "resolve_target" });
		expect(finished[0]).toMatchObject({ queuedAt: 0, queueWaitMs: 0, sampleDurationMs: 7_000,
			queueDepth: { waiting: 5, running: 0 }, stage: "publish", outcome: "completed",
			stageDurationsMs: { resolve_target: 0, base_probe: 7_000, process_probe: 0, parse: 0, publish: 0 } });
		expect(new Set(finished.map((entry) => entry.sampleId)).size).toBe(6);
		expect(new Set(finished.map((entry) => entry.collectorId)).size).toBe(1);
		expect(f.service.latest("ws")).toBeDefined();
		expect(JSON.stringify(f.info.mock.calls)).not.toContain("private-");
		expect(JSON.stringify(f.info.mock.calls)).not.toContain(REMOTE_METRICS_BASE_COMMAND);
		await reader.cancel(); f.service.close(); f.events.close();
	});

	it("correlates a failed probe with the following old samples failing target resolution", async () => {
		const f = fixture();
		const gate = deferred();
		f.execute.mockImplementationOnce(async () => { await gate.promise; return { exitCode: 0 }; });
		const reader = f.subscribe();
		await vi.advanceTimersByTimeAsync(0);
		const ownerError = new Error("SQLite owner unavailable");
		f.targets.resolveWorkspace.mockRejectedValue(ownerError);
		await vi.advanceTimersByTimeAsync(7_000);
		gate.reject(new Error("SSH handshake timed out"));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.execute).toHaveBeenCalledTimes(1);
		expect(f.targets.resolveWorkspace).toHaveBeenCalledTimes(6);
		expect(f.error).toHaveBeenCalledTimes(6);
		const failures = f.error.mock.calls.map((call) => call[1]);
		expect(failures[0]).toMatchObject({ stage: "base_probe", queueWaitMs: 0, sampleDurationMs: 7_000,
			queueDepth: { waiting: 5, running: 1 }, outcome: "failed", stageDurationsMs: { base_probe: 7_000 } });
		expect(failures.slice(1).map((entry) => entry.stage)).toEqual(Array(5).fill("resolve_target"));
		expect(failures.slice(1).map((entry) => entry.queueWaitMs)).toEqual([5_000, 4_000, 3_000, 1_000, 1_000]);
		expect(failures.slice(1).map((entry) => entry.error)).toEqual(Array(5).fill(ownerError));
		expect(failures.map((entry) => entry.sampleId)).toEqual(
			Array.from({ length: 6 }, (_, index) => `${failures[0].collectorId}:${index + 1}`),
		);
		expect(f.service.latest("ws")).toBeUndefined();
		await reader.cancel(); f.service.close(); f.events.close();
	});

	it("separates target, base and process wait durations without logging probe contents", async () => {
		const f = fixture();
		f.targets.resolveWorkspace.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100)); return target;
		});
		f.execute.mockImplementation(async (input) => {
			await new Promise((resolve) => setTimeout(resolve, input.command === REMOTE_METRICS_BASE_COMMAND ? 400 : 600));
			await input.onStdout(Buffer.from(input.command === REMOTE_METRICS_BASE_COMMAND ? baseOutput : processOutput));
			return { exitCode: 0 };
		});
		const reader = f.subscribe();
		await vi.advanceTimersByTimeAsync(1_100);
		expect(diagnostics(f.info, "sample.started")).toHaveLength(0);
		expect(diagnostics(f.info, "sample.finished")).toEqual([expect.objectContaining({
			sampleDurationMs: 1_100, queueWaitMs: 0,
			stageDurationsMs: { resolve_target: 100, base_probe: 400, process_probe: 600, parse: 0, publish: 0 },
		})]);
		expect(JSON.stringify(f.info.mock.calls)).not.toContain("private-");
		await reader.cancel(); f.service.close(); f.events.close();
	});

	it.each(["process_probe", "parse", "publish"] as const)("preserves the existing error path and identifies %s", async (stage) => {
		const f = fixture();
		if (stage === "process_probe") {
			f.execute.mockImplementationOnce(async (input) => { await input.onStdout(Buffer.from(baseOutput)); return { exitCode: 0 }; });
			f.execute.mockRejectedValueOnce(new Error("process probe failed"));
		} else if (stage === "parse") {
			f.execute.mockImplementationOnce(async (input) => { await input.onStdout(Buffer.from("invalid")); return { exitCode: 0 }; });
		} else {
			vi.spyOn(f.events, "publish").mockImplementationOnce(() => { throw new Error("publish failed"); });
		}
		const publish = vi.spyOn(f.events, "publish");
		const reader = f.subscribe();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.error).toHaveBeenCalledOnce();
		expect(f.error.mock.calls[0][1]).toMatchObject({ stage, outcome: "failed", queueWaitMs: 0 });
		expect(publish.mock.calls.some(([, event]) => event.type === "monitor.error")).toBe(true);
		expect(diagnostics(f.info, "sample.finished")).toHaveLength(0); // Fast failures retain the original single error log.
		await reader.cancel(); f.service.close(); f.events.close();
	});

	it("logs lifecycle boundaries and keeps healthy ticks quiet", async () => {
		const f = fixture();
		const first = f.subscribe();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(diagnostics(f.info, "sample.started")).toHaveLength(0);
		expect(diagnostics(f.info, "sample.finished")).toHaveLength(0);
		await first.cancel();
		const second = f.subscribe();
		await second.cancel();
		await vi.advanceTimersByTimeAsync(30_000);
		const stopped = diagnostics(f.info, "collector.stopped");
		expect(stopped).toEqual([expect.objectContaining({ reason: "no_subscribers", queueDepth: { waiting: 0, running: 0 } })]);
		expect(diagnostics(f.info, "collector.stop_cancelled")).toHaveLength(1);
		const third = f.subscribe();
		await vi.advanceTimersByTimeAsync(0);
		const started = diagnostics(f.info, "collector.started");
		expect(started).toHaveLength(2);
		expect(started[0].collectorId).not.toBe(started[1].collectorId);
		await third.cancel(); f.service.close(); f.events.close();
	});

	it("ignores diagnostic console failures without changing collector or queue progress", async () => {
		const f = fixture();
		f.info.mockImplementation(() => { throw new Error("diagnostic sink unavailable"); });
		const gate = deferred();
		f.execute.mockImplementationOnce(async (input) => {
			await gate.promise; await input.onStdout(Buffer.from(baseOutput)); return { exitCode: 0 };
		});
		const reader = f.subscribe();
		await vi.advanceTimersByTimeAsync(4_000);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.execute).toHaveBeenCalledTimes(6);
		expect(f.service.latest("ws")).toBeDefined();
		expect(f.error).not.toHaveBeenCalled();
		await reader.cancel(); f.service.close(); f.events.close();
	});
});
