import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_DISK_IO_COMMAND, RemoteDiskIoSampler } from "../src/application/monitoring/remote-disk-io-sampler.ts";

function disk(read: bigint | number | string, written: bigint | number | string, name = "sda", device = "8:0", sequence = "1") {
	return ["DISK_IO", name, device, sequence, read, written].join(" ") + "\n";
}
function probe(time: number | string, devices = disk(1000, 500)) {
	return "DISK_TIME " + time + "\n" + devices;
}

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("remote disk I/O sampling", () => {
	it("uses valid POSIX shell syntax", () => {
		const result = spawnSync("sh", ["-n", "-c", REMOTE_DISK_IO_COMMAND], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
	});

	it("samples visible whole leaf devices without adding partitions or stacked/loop/RAM devices", () => {
		const root = mkdtempSync(join(tmpdir(), "gori-disk-io-")); temporaryDirectories.push(root);
		const block = join(root, "block devices");
		mkdirSync(block);
		const addDisk = (name: string, device: string, sequence?: string) => {
			const path = join(block, name);
			mkdirSync(join(path, "slaves"), { recursive: true });
			writeFileSync(join(path, "dev"), device + "\n");
			writeFileSync(join(path, "stat"), "1 2 90071992547409921 4 5 6 90071992547409923 8 9 10 11\n");
			if (sequence) writeFileSync(join(path, "diskseq"), sequence + "\n");
			return path;
		};
		const sda = addDisk("sda", "8:0", "12");
		addDisk("nvme0n1", "259:0");
		const partition = addDisk("sda1", "8:1");
		writeFileSync(join(partition, "partition"), "1\n");
		for (const name of ["loop0", "ram0", "zram0", "fd0", "sr0"]) addDisk(name, "7:0");
		const mapped = addDisk("dm-0", "253:0");
		symlinkSync(sda, join(mapped, "slaves", "sda"));
		const raid = addDisk("md0", "9:0");
		symlinkSync(sda, join(raid, "slaves", "sda"));
		const missing = addDisk("vdb", "252:16");
		rmSync(join(missing, "stat"));
		const uptime = join(root, "uptime");
		writeFileSync(uptime, "102.5 33.0\n");
		const command = REMOTE_DISK_IO_COMMAND.replaceAll("/sys/block", block).replaceAll("/proc/uptime", uptime);
		const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n").sort()).toEqual([
			"DISK_IO nvme0n1 259:0 - 90071992547409921 90071992547409923",
			"DISK_IO sda 8:0 12 90071992547409921 90071992547409923",
			"DISK_TIME 102.5",
		]);
	});

	it("keeps missing optional files silent and leaves following probes successful", () => {
		const root = mkdtempSync(join(tmpdir(), "gori-disk-missing-")); temporaryDirectories.push(root);
		const command = REMOTE_DISK_IO_COMMAND.replaceAll("/sys/block", join(root, "missing"))
			.replaceAll("/proc/uptime", join(root, "uptime")) + "; printf 'CPU still-running\\n'";
		const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("CPU still-running\n");
	});

	it("waits for a baseline and converts summed sectors with actual remote elapsed time", () => {
		const sampler = new RemoteDiskIoSampler();
		expect(sampler.sample(probe(100, disk(1000, 500) + disk(2000, 1000, "nvme0n1", "259:0")), "server:1"))
			.toEqual({ readBytesPerSecond: null, writeBytesPerSecond: null });
		expect(sampler.sample(probe(103, disk(1006, 503) + disk(2006, 1003, "nvme0n1", "259:0")), "server:1"))
			.toEqual({ readBytesPerSecond: 2048, writeBytesPerSecond: 1024 });
		expect(sampler.sample(probe(105, disk(1006, 503) + disk(2006, 1003, "nvme0n1", "259:0")), "server:1"))
			.toEqual({ readBytesPerSecond: 0, writeBytesPerSecond: 0 });
	});

	it("preserves cumulative counters above the JavaScript safe-integer limit", () => {
		const sampler = new RemoteDiskIoSampler();
		sampler.sample(probe(100, disk("90071992547409920", "90071992547409920")), "server");
		expect(sampler.sample(probe(102, disk("90071992547409922", "90071992547409926")), "server"))
			.toEqual({ readBytesPerSecond: 512, writeBytesPerSecond: 1536 });
	});

	it("retains the last rate and baseline for coincident or sub-second probes", () => {
		const sampler = new RemoteDiskIoSampler();
		sampler.sample(probe(100), "server");
		const rate = sampler.sample(probe(102, disk(1004, 502)), "server");
		expect(sampler.sample(probe(102.01, disk(1005, 503)), "server")).toEqual(rate);
		expect(sampler.sample(probe(102, disk(1005, 503)), "server")).toEqual(rate);
		expect(sampler.sample(probe(104, disk(1008, 504)), "server"))
			.toEqual({ readBytesPerSecond: 1024, writeBytesPerSecond: 512 });
	});

	it.each([
		[probe(102, disk(2000, 1000)), "server:2"],
		[probe(1, disk(2000, 1000)), "server:1"],
		[probe(102, disk(10, 1000)), "server:1"],
		[probe(102, disk(2000, 10)), "server:1"],
		[probe(102, disk(2000, 1000, "vda", "252:0")), "server:1"],
		[probe(102, disk(2000, 1000, "sda", "8:16")), "server:1"],
		[probe(102, disk(2000, 1000, "sda", "8:0", "2")), "server:1"],
		[probe(102, disk(2000, 1000) + disk(2000, 1000, "sdb", "8:16")), "server:1"],
	])("rebuilds the baseline after source, clock, device or counter changes", (output, source) => {
		const sampler = new RemoteDiskIoSampler();
		sampler.sample(probe(100), "server:1");
		expect(sampler.sample(output, source)).toEqual({ readBytesPerSecond: null, writeBytesPerSecond: null });
	});

	it("detects one device reset even when the aggregate counter still increases", () => {
		const sampler = new RemoteDiskIoSampler();
		sampler.sample(probe(100, disk(1000, 500) + disk(2000, 1000, "sdb", "8:16")), "server");
		expect(sampler.sample(probe(102, disk(10, 10) + disk(9000, 9000, "sdb", "8:16")), "server"))
			.toEqual({ readBytesPerSecond: null, writeBytesPerSecond: null });
	});

	it("does not reset just because the kernel returns devices in a different order", () => {
		const sampler = new RemoteDiskIoSampler();
		sampler.sample(probe(100, disk(1000, 500) + disk(2000, 1000, "sdb", "8:16")), "server");
		expect(sampler.sample(probe(102, disk(2002, 1002, "sdb", "8:16") + disk(1002, 502)), "server"))
			.toEqual({ readBytesPerSecond: 1024, writeBytesPerSecond: 1024 });
	});

	it.each([
		"CPU 100 20 30\n",
		"DISK_TIME 100\n",
		probe("NaN"),
		probe("9".repeat(400)),
		probe(100, disk("-1", 500)),
		probe(100, disk("bad", 500)),
		probe(100, disk(1000, 500, "sda", "invalid")),
		probe(100, disk(1000, 500, "sda", "8:0", "invalid")),
		probe(100, disk(1000, 500) + disk(1000, 500)),
	])("omits malformed or missing optional statistics and discards the old baseline", (output) => {
		const sampler = new RemoteDiskIoSampler();
		sampler.sample(probe(98), "server");
		expect(sampler.sample(output, "server")).toBeUndefined();
		expect(sampler.sample(probe(102, disk(2000, 1000)), "server"))
			.toEqual({ readBytesPerSecond: null, writeBytesPerSecond: null });
	});

	it("never emits non-finite JSON rates", () => {
		const sampler = new RemoteDiskIoSampler();
		sampler.sample(probe(100), "server");
		expect(sampler.sample(probe(102, disk("9".repeat(400), 1000)), "server"))
			.toEqual({ readBytesPerSecond: null, writeBytesPerSecond: null });
	});
});
