import type { RemoteNetworkMetrics } from "../../domain/remote-network-metrics.ts";

/** Optional reads: missing network statistics must not break CPU or memory collection. */
export const REMOTE_NETWORK_COMMAND = [
	`if [ -r /proc/net/dev ]; then awk 'NR > 2 { sub(/:/, " "); print "NET", $1, $2, $10 }' /proc/net/dev; fi`,
	`if [ -r /proc/net/route ]; then awk 'NR > 1 { print "NET_ROUTE4", $1, $2, $4, $7 }' /proc/net/route; fi`,
	`if [ -r /proc/net/ipv6_route ]; then awk '{ print "NET_ROUTE6", $10, $1, $2, $9, $6 }' /proc/net/ipv6_route; fi`,
	`awk '{ print "NET_TIME", $1 }' /proc/uptime`,
	"true",
].join("; ");

interface NetworkCounters {
	interfaceName: string;
	received: bigint;
	transmitted: bigint;
	uptimeSeconds: number;
	source: string;
}

interface DefaultRoute {
	interfaceName: string;
	metric: number;
	family: 4 | 6;
}

export class RemoteNetworkSampler {
	private previous?: NetworkCounters;
	private latest?: RemoteNetworkMetrics;

	sample(output: string, source: string): RemoteNetworkMetrics | undefined {
		const current = readCounters(output, source);
		const previous = this.previous;
		if (!current) {
			this.previous = undefined;
			this.latest = undefined;
			return undefined;
		}

		const elapsed = previous ? current.uptimeSeconds - previous.uptimeSeconds : 0;
		const comparable = previous && previous.source === source &&
			previous.interfaceName === current.interfaceName && elapsed >= 0 &&
			current.received >= previous.received && current.transmitted >= previous.transmitted;
		// Base and process timers can coincide. Keep the prior rate and baseline for
		// sub-second probes, so the next useful sample includes all intervening bytes.
		if (comparable && elapsed < 1) return this.latest;
		this.previous = current;
		this.latest = {
			interfaceName: current.interfaceName,
			receiveBytesPerSecond: comparable ? Number(current.received - previous.received) / elapsed : null,
			transmitBytesPerSecond: comparable ? Number(current.transmitted - previous.transmitted) / elapsed : null,
		};
		return this.latest;
	}
}

function readCounters(output: string, source: string): NetworkCounters | undefined {
	const interfaces = new Map<string, { received: bigint; transmitted: bigint }>();
	const routes: DefaultRoute[] = [];
	let uptimeSeconds: number | undefined;
	for (const line of output.split("\n")) {
		const [tag, ...fields] = line.trim().split(/\s+/);
		if (tag === "NET" && fields.length === 3 && /^\d+$/.test(fields[1]) && /^\d+$/.test(fields[2])) {
			interfaces.set(fields[0], { received: BigInt(fields[1]), transmitted: BigInt(fields[2]) });
		} else if (tag === "NET_TIME" && /^\d+(\.\d+)?$/.test(fields[0] ?? "")) {
			uptimeSeconds = Number(fields[0]);
		} else if (tag === "NET_ROUTE4" || tag === "NET_ROUTE6") {
			const route = readDefaultRoute(tag, fields);
			if (route) routes.push(route);
		}
	}
	if (uptimeSeconds === undefined || !Number.isFinite(uptimeSeconds)) return undefined;
	// Prefer IPv4, then its lowest route metric. Never sum bridge and virtual interfaces.
	const route = routes.filter((item) => item.interfaceName !== "lo" && interfaces.has(item.interfaceName))
		.sort((left, right) => left.family - right.family || left.metric - right.metric ||
			left.interfaceName.localeCompare(right.interfaceName))[0];
	const counters = route && interfaces.get(route.interfaceName);
	return route && counters ? { ...counters, interfaceName: route.interfaceName, uptimeSeconds, source } : undefined;
}

function readDefaultRoute(tag: string, fields: string[]): DefaultRoute | undefined {
	const ipv4 = tag === "NET_ROUTE4";
	const [interfaceName, destination] = fields;
	const flags = fields[ipv4 ? 2 : 3];
	const metric = fields[ipv4 ? 3 : 4];
	if (!interfaceName || !/^0+$/.test(destination ?? "") || (!ipv4 && fields[2] !== "00")) return undefined;
	if (!/^[\da-f]+$/i.test(flags ?? "") || !(ipv4 ? /^\d+$/ : /^[\da-f]+$/i).test(metric ?? "")) return undefined;
	const flagBits = Number.parseInt(flags, 16);
	if ((flagBits & 1) === 0 || (flagBits & 0x200) !== 0) return undefined;
	return { interfaceName, metric: Number.parseInt(metric, ipv4 ? 10 : 16), family: ipv4 ? 4 : 6 };
}
