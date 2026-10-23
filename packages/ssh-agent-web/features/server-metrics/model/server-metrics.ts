export interface ServerNetworkMetrics {
	interfaceName: string;
	receiveBytesPerSecond: number | null;
	transmitBytesPerSecond: number | null;
}

export interface ServerDiskIoMetrics {
	readBytesPerSecond: number | null;
	writeBytesPerSecond: number | null;
}

/** The session header consumes only this projection of the Workspace monitoring event. */
export interface ServerMetricsSnapshot {
	workspaceId: string;
	sampledAt: number;
	cpu: { usagePercent: number };
	memory: { usagePercent: number; usedBytes: number; totalBytes: number };
	network?: ServerNetworkMetrics;
	diskIo?: ServerDiskIoMetrics;
}

export type ServerMetricsStatus = "sampling" | "live" | "reconnecting" | "unavailable" | "stale";
export interface ServerMetricsState {
	status: ServerMetricsStatus;
	snapshot?: ServerMetricsSnapshot;
	error?: string;
}

export const INITIAL_SERVER_METRICS_STATE: ServerMetricsState = { status: "sampling" };
export const SERVER_METRICS_STALE_MS = 10_000;

export function parseServerMetricsSnapshot(value: unknown): ServerMetricsSnapshot | undefined {
	if (!isRecord(value) || typeof value.workspaceId !== "string" || !nonnegative(value.sampledAt)) return undefined;
	const { cpu, memory } = value;
	if (!isRecord(cpu) || !percentage(cpu.usagePercent) || !isRecord(memory) ||
		!percentage(memory.usagePercent) || !nonnegative(memory.usedBytes) || !nonnegative(memory.totalBytes)) return undefined;
	const network = parseNetwork(value.network);
	const diskIo = parseDiskIo(value.diskIo);
	return {
		workspaceId: value.workspaceId, sampledAt: value.sampledAt,
		cpu: { usagePercent: cpu.usagePercent },
		memory: { usagePercent: memory.usagePercent, usedBytes: memory.usedBytes, totalBytes: memory.totalBytes },
		...(network ? { network } : {}),
		...(diskIo ? { diskIo } : {}),
	};
}

function parseDiskIo(value: unknown): ServerDiskIoMetrics | undefined {
	if (!isRecord(value) ||
		!(value.readBytesPerSecond === null || nonnegative(value.readBytesPerSecond)) ||
		!(value.writeBytesPerSecond === null || nonnegative(value.writeBytesPerSecond))) return undefined;
	return { readBytesPerSecond: value.readBytesPerSecond, writeBytesPerSecond: value.writeBytesPerSecond };
}

function parseNetwork(value: unknown): ServerNetworkMetrics | undefined {
	if (!isRecord(value) || typeof value.interfaceName !== "string" || !value.interfaceName ||
		!(value.receiveBytesPerSecond === null || nonnegative(value.receiveBytesPerSecond)) ||
		!(value.transmitBytesPerSecond === null || nonnegative(value.transmitBytesPerSecond))) return undefined;
	return { interfaceName: value.interfaceName, receiveBytesPerSecond: value.receiveBytesPerSecond,
		transmitBytesPerSecond: value.transmitBytesPerSecond };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function percentage(value: unknown): value is number {
	return nonnegative(value) && value <= 100;
}
