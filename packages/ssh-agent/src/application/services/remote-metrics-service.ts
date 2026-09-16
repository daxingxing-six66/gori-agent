import type { RemoteCommandBroker, SshConnectionPoolControl } from "../ssh-channel-broker.ts";
import type { RemoteMetricsSnapshot, WorkspaceEventHub } from "../workspace-event-hub.ts";
import type { WorkspaceSshTargetResolver } from "./ssh-target-resolver.ts";

export const REMOTE_METRICS_BASE_COMMAND = [
	"LC_ALL=C",
	`printf 'CORES %s\\n' "$(getconf _NPROCESSORS_ONLN)"`,
	`awk '/^cpu / { print "CPU", $2, $3, $4, $5, $6, $7, $8, $9 }' /proc/stat`,
	`awk '/^MemTotal:/ { total=$2 } /^MemAvailable:/ { available=$2 } END { print "MEM", total, available }' /proc/meminfo`,
	`awk '{ print "LOAD", $1, $2, $3 }' /proc/loadavg`,
	`awk '{ print "UP", $1 }' /proc/uptime`,
	`df -Pk | awk 'NR > 1 { print "FS", $1, $2, $3, $6 }'`,
].join("; ");

export const REMOTE_METRICS_PROCESS_COMMAND = `LC_ALL=C; ps -eo pid=,ppid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=,args= --sort=-pcpu | head -20 | sed 's/^/PROC /'`;

interface CpuCounters {
	busy: number;
	total: number;
}
interface Collector {
	workspaceId: string;
	baseTimer?: ReturnType<typeof setInterval>;
	processTimer?: ReturnType<typeof setInterval>;
	stopTimer?: ReturnType<typeof setTimeout>;
	queue: Promise<void>;
	cpu?: CpuCounters;
	latest?: RemoteMetricsSnapshot;
}

export class RemoteMetricsService {
	private readonly collectors = new Map<string, Collector>();
	private readonly unsubscribe: () => void;
	private readonly options: {
		targets: WorkspaceSshTargetResolver;
		broker: RemoteCommandBroker & Pick<SshConnectionPoolControl, "snapshotWorkspace">;
		events: WorkspaceEventHub;
	};

	constructor(options: {
		targets: WorkspaceSshTargetResolver;
		broker: RemoteCommandBroker & Pick<SshConnectionPoolControl, "snapshotWorkspace">;
		events: WorkspaceEventHub;
	}) {
		this.options = options;
		this.unsubscribe = options.events.onTopicCountChange((workspaceId, topic, count) => {
			if (topic !== "monitoring") return;
			if (count > 0) this.start(workspaceId);
			else this.scheduleStop(workspaceId);
		});
	}

	latest(workspaceId: string): RemoteMetricsSnapshot | undefined {
		return this.collectors.get(workspaceId)?.latest;
	}

	close(): void {
		this.unsubscribe();
		for (const collector of this.collectors.values()) this.stop(collector);
		this.collectors.clear();
	}

	private start(workspaceId: string): void {
		const existing = this.collectors.get(workspaceId);
		if (existing) {
			if (existing.stopTimer) clearTimeout(existing.stopTimer);
			existing.stopTimer = undefined;
			return;
		}
		const collector: Collector = { workspaceId, queue: Promise.resolve() };
		this.collectors.set(workspaceId, collector);
		this.enqueue(collector, true);
		collector.baseTimer = setInterval(() => this.enqueue(collector, false), 2_000);
		collector.processTimer = setInterval(() => this.enqueue(collector, true), 3_000);
	}

	private scheduleStop(workspaceId: string): void {
		const collector = this.collectors.get(workspaceId);
		if (!collector || collector.stopTimer) return;
		collector.stopTimer = setTimeout(() => {
			if (this.options.events.count(workspaceId, "monitoring") === 0) {
				this.stop(collector);
				this.collectors.delete(workspaceId);
			}
		}, 30_000);
	}

	private stop(collector: Collector): void {
		if (collector.baseTimer) clearInterval(collector.baseTimer);
		if (collector.processTimer) clearInterval(collector.processTimer);
		if (collector.stopTimer) clearTimeout(collector.stopTimer);
	}

	private enqueue(collector: Collector, includeProcesses: boolean): void {
		collector.queue = collector.queue.then(() => this.sample(collector, includeProcesses)).catch(() => {});
	}

	private async sample(collector: Collector, includeProcesses: boolean): Promise<void> {
		try {
			const target = await this.options.targets.resolveWorkspace(collector.workspaceId);
			const base = await executeProbe(this.options.broker, target, REMOTE_METRICS_BASE_COMMAND);
			const process = includeProcesses
				? await executeProbe(this.options.broker, target, REMOTE_METRICS_PROCESS_COMMAND)
				: undefined;
			const parsed = parseRemoteMetricsBase(base, collector.cpu);
			collector.cpu = parsed.counters;
			const snapshot: RemoteMetricsSnapshot = {
				workspaceId: collector.workspaceId,
				sampledAt: Date.now(),
				cpu: parsed.cpu,
				memory: parsed.memory,
				filesystems: parsed.filesystems,
				uptimeSeconds: parsed.uptimeSeconds,
				processes: process === undefined ? (collector.latest?.processes ?? []) : parseRemoteProcesses(process),
			};
			collector.latest = snapshot;
			this.options.events.publish(collector.workspaceId, { type: "monitor.snapshot", data: snapshot });
			this.options.events.publish(collector.workspaceId, {
				type: "connection.snapshot",
				data: this.options.broker.snapshotWorkspace(collector.workspaceId),
			});
		} catch (error) {
			console.error("SSH Agent remote metrics collection failed", {
				workspaceId: collector.workspaceId,
				error,
			});
			this.options.events.publish(collector.workspaceId, {
				type: "monitor.error",
				data: {
					sampledAt: Date.now(),
					code: "monitor_probe_failed",
					message: "Remote metrics collection failed",
					messageKey: "monitor.probe_failed",
				},
			});
		}
	}
}

async function executeProbe(
	broker: RemoteCommandBroker,
	target: Parameters<RemoteCommandBroker["execute"]>[0]["target"],
	command: string,
): Promise<string> {
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	let stderrBytes = 0;
	const result = await broker.execute({
		target,
		command,
		signal: new AbortController().signal,
		onStdout: async (chunk) => {
			stdout.push(chunk);
		},
		onStderr: async (chunk) => {
			if (stderrBytes >= 4_096) return;
			const remaining = 4_096 - stderrBytes;
			const retained = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
			stderr.push(retained);
			stderrBytes += retained.byteLength;
		},
	});
	if (result.exitCode !== 0) {
		const detail = Buffer.concat(stderr.map((chunk) => Buffer.from(chunk)))
			.toString("utf8")
			.trim();
		throw new Error(
			`Remote metrics command failed with exit code ${result.exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`,
		);
	}
	return Buffer.concat(stdout.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export function parseRemoteMetricsBase(
	output: string,
	previous?: CpuCounters,
): {
	counters: CpuCounters;
	cpu: RemoteMetricsSnapshot["cpu"];
	memory: RemoteMetricsSnapshot["memory"];
	filesystems: RemoteMetricsSnapshot["filesystems"];
	uptimeSeconds: number;
} {
	let counters: CpuCounters | undefined;
	let cores = 0;
	let memory: RemoteMetricsSnapshot["memory"] | undefined;
	let loadAverage: [number, number, number] = [0, 0, 0];
	let uptimeSeconds = 0;
	const filesystems: RemoteMetricsSnapshot["filesystems"] = [];
	for (const line of output.trim().split("\n")) {
		const values = line.trim().split(/\s+/);
		if (values[0] === "CORES") cores = Number(values[1]);
		else if (values[0] === "CPU") {
			const numbers = values.slice(1).map(Number);
			const idle = (numbers[3] ?? 0) + (numbers[4] ?? 0);
			const total = numbers.reduce((sum, value) => sum + value, 0);
			counters = { busy: total - idle, total };
		} else if (values[0] === "MEM") {
			const totalBytes = Number(values[1]) * 1024;
			const availableBytes = Number(values[2]) * 1024;
			const usedBytes = totalBytes - availableBytes;
			memory = { totalBytes, usedBytes, usagePercent: percent(usedBytes, totalBytes) };
		} else if (values[0] === "LOAD") loadAverage = [Number(values[1]), Number(values[2]), Number(values[3])];
		else if (values[0] === "UP") uptimeSeconds = Number(values[1]);
		else if (values[0] === "FS") {
			const totalBytes = Number(values[2]) * 1024;
			const usedBytes = Number(values[3]) * 1024;
			filesystems.push({
				device: values[1] ?? "",
				mountPoint: values[4] ?? "",
				totalBytes,
				usedBytes,
				usagePercent: percent(usedBytes, totalBytes),
			});
		}
	}
	if (!counters || !memory) throw new Error("Remote metrics output was incomplete");
	const usagePercent =
		previous && counters.total > previous.total
			? percent(counters.busy - previous.busy, counters.total - previous.total)
			: 0;
	return { counters, cpu: { usagePercent, cores, loadAverage }, memory, filesystems, uptimeSeconds };
}

export function parseRemoteProcesses(output: string): RemoteMetricsSnapshot["processes"] {
	return output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const match = /^PROC\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(
				line,
			);
			if (!match) throw new Error("Remote process output was invalid");
			return {
				pid: Number(match[1]),
				parentPid: Number(match[2]),
				user: match[3] ?? "",
				state: match[4] ?? "",
				cpuPercent: Number(match[5]),
				memoryPercent: Number(match[6]),
				residentBytes: Number(match[7]) * 1024,
				elapsedSeconds: Number(match[8]),
				command: match[10] || match[9] || "",
			};
		});
}

function percent(value: number, total: number): number {
	return total <= 0 ? 0 : Math.round((value / total) * 10_000) / 100;
}
