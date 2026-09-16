import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	parseRemoteMetricsBase,
	parseRemoteProcesses,
	REMOTE_METRICS_BASE_COMMAND,
	REMOTE_METRICS_PROCESS_COMMAND,
} from "../src/application/services/remote-metrics-service.ts";

describe("remote metrics parsers", () => {
	it("keeps both fixed remote probe commands valid POSIX shell syntax", () => {
		for (const command of [REMOTE_METRICS_BASE_COMMAND, REMOTE_METRICS_PROCESS_COMMAND]) {
			const result = spawnSync("sh", ["-n", "-c", command], { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
		}
	});

	it("computes CPU deltas and parses memory, disk, load, and uptime", () => {
		const first = parseRemoteMetricsBase(`CORES 4
CPU 100 10 20 800 5 2 3 0
MEM 8000000 3000000
LOAD 0.82 0.70 0.60
UP 1234.5
FS /dev/vda1 80000000 58400000 /
`);
		const second = parseRemoteMetricsBase(
			`CORES 4
CPU 130 10 30 830 5 2 3 0
MEM 8000000 2000000
LOAD 1.2 0.9 0.7
UP 1236.5
FS /dev/vda1 80000000 60000000 /
`,
			first.counters,
		);
		expect(second.cpu).toEqual({ usagePercent: 57.14, cores: 4, loadAverage: [1.2, 0.9, 0.7] });
		expect(second.memory).toEqual({ totalBytes: 8_192_000_000, usedBytes: 6_144_000_000, usagePercent: 75 });
		expect(second.filesystems[0]).toMatchObject({ device: "/dev/vda1", mountPoint: "/", usagePercent: 75 });
		expect(second.uptimeSeconds).toBe(1236.5);
	});

	it("parses the fixed process probe format", () => {
		expect(parseRemoteProcesses("PROC 42 1 root S 12.5 4.2 1024 90 node node server.js\n")).toEqual([
			{
				pid: 42,
				parentPid: 1,
				user: "root",
				state: "S",
				cpuPercent: 12.5,
				memoryPercent: 4.2,
				residentBytes: 1_048_576,
				elapsedSeconds: 90,
				command: "node server.js",
			},
		]);
	});

	it("rejects incomplete snapshots", () => {
		expect(() => parseRemoteMetricsBase("LOAD 1 2 3")).toThrow("incomplete");
	});
});
