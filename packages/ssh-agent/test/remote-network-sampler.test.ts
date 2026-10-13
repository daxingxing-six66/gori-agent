import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { REMOTE_NETWORK_COMMAND, RemoteNetworkSampler } from "../src/application/monitoring/remote-network-sampler.ts";

function probe(time: number, received: string | number, transmitted: string | number, name = "eth0") {
	return `NET_TIME ${time}\nNET ${name} ${received} ${transmitted}\nNET_ROUTE4 ${name} 00000000 0003 100\n`;
}

describe("remote network sampling", () => {
	it("uses a non-blocking fixed POSIX shell probe", () => {
		expect(spawnSync("sh", ["-n", "-c", REMOTE_NETWORK_COMMAND]).status).toBe(0);
	});

	it("waits for a baseline and uses the actual elapsed remote time", () => {
		const sampler = new RemoteNetworkSampler();
		expect(sampler.sample(probe(100, 1000, 500), "server:1")).toEqual({
			interfaceName: "eth0", receiveBytesPerSecond: null, transmitBytesPerSecond: null,
		});
		expect(sampler.sample(probe(103, 4072, 2036), "server:1")).toEqual({
			interfaceName: "eth0", receiveBytesPerSecond: 1024, transmitBytesPerSecond: 512,
		});
		expect(sampler.sample(probe(105, 4072, 2036), "server:1")?.receiveBytesPerSecond).toBe(0);
	});

	it("preserves precision for counters above the JavaScript safe-integer limit", () => {
		const sampler = new RemoteNetworkSampler();
		sampler.sample(probe(100, "90071992547409920", "90071992547409920"), "server");
		expect(sampler.sample(probe(102, "90071992547409922", "90071992547409926"), "server")).toMatchObject({
			receiveBytesPerSecond: 1, transmitBytesPerSecond: 3,
		});
	});

	it("keeps the last rate for coincident probes and carries their bytes into the next sample", () => {
		const sampler = new RemoteNetworkSampler();
		sampler.sample(probe(100, 1000, 500), "server");
		const rate = sampler.sample(probe(102, 3048, 1524), "server");
		expect(sampler.sample(probe(102.01, 3070, 1550), "server")).toEqual(rate);
		expect(sampler.sample(probe(102, 3070, 1550), "server")).toEqual(rate);
		expect(sampler.sample(probe(104, 5096, 2548), "server")).toMatchObject({
			receiveBytesPerSecond: 1024, transmitBytesPerSecond: 512,
		});
	});

	it.each([
		[probe(102, 2000, 1000), "server:2"],
		[probe(1, 2000, 1000), "server:1"],
		[probe(102, 10, 1000), "server:1"],
		[probe(102, 2000, 10), "server:1"],
		[probe(102, 2000, 1000, "ens3"), "server:1"],
		[probe(100, 2000, 1000), "server:1"],
	])("re-establishes a baseline after source, clock, interface or counter changes", (output, source) => {
		const sampler = new RemoteNetworkSampler();
		sampler.sample(probe(100, 1000, 500), "server:1");
		expect(sampler.sample(output, source)).toMatchObject({ receiveBytesPerSecond: null, transmitBytesPerSecond: null });
	});

	it("selects the lowest-metric usable default route without adding container or loopback traffic", () => {
		const sampler = new RemoteNetworkSampler();
		const routes = "NET_ROUTE4 eth0 00000000 0003 100\nNET_ROUTE4 ens3 00000000 0003 50\n";
		const output = (time: number, rx: number) => `NET_TIME ${time}\n${routes}NET ens3 ${rx} 500\n` +
			"NET eth0 900000 900000\nNET docker0 900000 900000\nNET lo 900000 900000\n";
		sampler.sample(output(100, 1000), "server");
		expect(sampler.sample(output(102, 3048), "server")).toEqual({
			interfaceName: "ens3", receiveBytesPerSecond: 1024, transmitBytesPerSecond: 0,
		});
	});

	it("supports an IPv6-only default route and ignores down, reject and non-default routes", () => {
		const output = "NET_TIME 100\nNET ens3 1000 500\n" +
			"NET_ROUTE4 ens3 00000000 0000 0\nNET_ROUTE4 ens3 00000000 0201 0\n" +
			"NET_ROUTE6 ens3 20010db8000000000000000000000000 40 00000001 00000000\n" +
			"NET_ROUTE6 ens3 00000000000000000000000000000000 00 00000003 00000064\n";
		expect(new RemoteNetworkSampler().sample(output, "server")?.interfaceName).toBe("ens3");
	});

	it("treats missing or malformed network data as unavailable and discards the baseline", () => {
		const sampler = new RemoteNetworkSampler();
		sampler.sample(probe(100, 1000, 500), "server");
		expect(sampler.sample("CPU 10 20 30\n", "server")).toBeUndefined();
		expect(sampler.sample(probe(102, 2000, 1000), "server")?.receiveBytesPerSecond).toBeNull();
		expect(sampler.sample(probe(104, "invalid", 1000), "server")).toBeUndefined();
		expect(sampler.sample("NET_TIME 106\nNET eth0 3000 1000\n", "server")).toBeUndefined();
	});
});
