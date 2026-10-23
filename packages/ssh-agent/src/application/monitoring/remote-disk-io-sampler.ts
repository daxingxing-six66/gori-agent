import type { RemoteDiskIoMetrics } from "../../domain/remote-disk-io-metrics.ts";

/** Optional Linux reads: no extra exec, sleep or dependency on iostat. */
export const REMOTE_DISK_IO_COMMAND = `(
	if [ -r /proc/uptime ]; then awk '{ print "DISK_TIME", $1 }' /proc/uptime; fi
	for disk_path in "/sys/block"/*; do
		[ -r "$disk_path/stat" ] && [ -r "$disk_path/dev" ] || continue
		[ -e "$disk_path/partition" ] && continue
		case "$disk_path" in */loop*|*/ram*|*/zram*|*/fd*|*/sr*) continue ;; esac
		[ -r "$disk_path/slaves" ] && [ -x "$disk_path/slaves" ] || continue
		set -- "$disk_path"/slaves/*
		if [ -e "$1" ] || [ -L "$1" ]; then continue; fi
		IFS= read -r disk_id < "$disk_path/dev" || continue
		disk_seq=-
		if [ -r "$disk_path/diskseq" ]; then IFS= read -r disk_seq < "$disk_path/diskseq" || disk_seq=-; fi
		awk -v name="$disk_path" -v identity="$disk_id" -v sequence="$disk_seq" '
			BEGIN { sub(/^.*\\//, "", name) }
			NF >= 11 { print "DISK_IO", name, identity, sequence, $3, $7 }
		' "$disk_path/stat"
	done
	true
) 2>/dev/null`;

interface DeviceCounters {
	readonly readSectors: bigint;
	readonly writeSectors: bigint;
}

interface DiskCounters {
	readonly devices: ReadonlyMap<string, DeviceCounters>;
	readonly uptimeSeconds: number;
	readonly source: string;
}

/** Owns only the sampling baseline; counters and device identities never enter SSE. */
export class RemoteDiskIoSampler {
	private previous?: DiskCounters;
	private latest?: RemoteDiskIoMetrics;

	sample(output: string, source: string): RemoteDiskIoMetrics | undefined {
		const current = readCounters(output, source);
		const previous = this.previous;
		if (!current) {
			this.previous = undefined;
			this.latest = undefined;
			return undefined;
		}
		const elapsed = previous ? current.uptimeSeconds - previous.uptimeSeconds : 0;
		const comparable = previous && previous.source === source && elapsed >= 0 &&
			previous.devices.size === current.devices.size &&
			[...current.devices].every(([id, counters]) => {
				const before = previous.devices.get(id);
				return before && counters.readSectors >= before.readSectors && counters.writeSectors >= before.writeSectors;
			});
		// Base/process timers can coincide. Preserve the original baseline and all
		// intervening I/O until the next sample with a useful time interval.
		if (comparable && elapsed < 1) return this.latest;
		this.previous = current;
		let readBytesPerSecond: number | null = null;
		let writeBytesPerSecond: number | null = null;
		if (comparable) {
			let readSectors = 0n;
			let writeSectors = 0n;
			for (const [id, counters] of current.devices) {
				const before = previous.devices.get(id)!;
				readSectors += counters.readSectors - before.readSectors;
				writeSectors += counters.writeSectors - before.writeSectors;
			}
			// Linux stat sectors are always 512 bytes, independent of block size.
			const readRate = Number(readSectors * 512n) / elapsed;
			const writeRate = Number(writeSectors * 512n) / elapsed;
			if (Number.isFinite(readRate) && Number.isFinite(writeRate)) {
				readBytesPerSecond = readRate;
				writeBytesPerSecond = writeRate;
			}
		}
		this.latest = { readBytesPerSecond, writeBytesPerSecond };
		return this.latest;
	}
}

function readCounters(output: string, source: string): DiskCounters | undefined {
	const devices = new Map<string, DeviceCounters>();
	let uptimeSeconds: number | undefined;
	for (const line of output.split("\n")) {
		const [tag, ...fields] = line.trim().split(/\s+/);
		if (tag === "DISK_TIME") {
			if (fields.length !== 1 || !/^\d+(\.\d+)?$/.test(fields[0])) return undefined;
			uptimeSeconds = Number(fields[0]);
		} else if (tag === "DISK_IO") {
			const [name, device, sequence, read, written] = fields;
			if (fields.length !== 5 || !name || !/^\d+:\d+$/.test(device) ||
				!/^(-|\d+)$/.test(sequence) || !/^\d+$/.test(read) || !/^\d+$/.test(written)) return undefined;
			const id = name + ":" + device + ":" + sequence;
			if (devices.has(id)) return undefined;
			devices.set(id, { readSectors: BigInt(read), writeSectors: BigInt(written) });
		}
	}
	return devices.size > 0 && uptimeSeconds !== undefined && Number.isFinite(uptimeSeconds)
		? { devices, uptimeSeconds, source } : undefined;
}
