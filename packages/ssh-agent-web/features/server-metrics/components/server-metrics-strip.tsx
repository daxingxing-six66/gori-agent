"use client";

import { Cpu, MemoryStick, Network } from "lucide-react";
import { useIntl } from "react-intl";
import type { ServerMetricsState } from "../model/server-metrics";
import "./server-metrics.css";

export function ServerMetricsStrip({ state }: { state: ServerMetricsState }) {
	const intl = useIntl();
	const metrics = state.snapshot;
	const network = metrics?.network;
	const cpu = formatPercent(metrics?.cpu.usagePercent);
	const memory = formatPercent(metrics?.memory.usagePercent);
	const upload = formatRate(network?.transmitBytesPerSecond);
	const download = formatRate(network?.receiveBytesPerSecond);
	const status = intl.formatMessage({ id: `serverMetrics.status.${state.status}` });
	const updated = metrics ? intl.formatMessage({ id: "serverMetrics.updated" }, {
		time: intl.formatTime(metrics.sampledAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
	}) : "";
	const detail = [status, updated, state.error].filter(Boolean).join(" · ");
	const cpuLabel = intl.formatMessage({ id: "serverMetrics.cpu" }, { value: cpu });
	const memoryLabel = intl.formatMessage({ id: "serverMetrics.memory" }, { value: memory });
	const uploadLabel = intl.formatMessage({ id: "serverMetrics.upload" }, { value: upload });
	const downloadLabel = intl.formatMessage({ id: "serverMetrics.download" }, { value: download });
	const networkDetail = network ? intl.formatMessage({ id: "serverMetrics.interface" }, { name: network.interfaceName }) :
		intl.formatMessage({ id: "serverMetrics.networkUnavailable" });
	const ratePending = network && (network.transmitBytesPerSecond === null || network.receiveBytesPerSecond === null);

	return <div className="server-metrics-strip" data-state={state.status} role="group"
		aria-label={intl.formatMessage({ id: "serverMetrics.label" })} title={detail}>
		<span className="server-metric" aria-label={cpuLabel} title={`${cpuLabel} · ${detail}`}>
			<Cpu size={13} aria-hidden="true" /><span>{cpu}</span>
		</span>
		<span className="server-metric" aria-label={memoryLabel} title={`${memoryLabel} · ${detail}`}>
			<MemoryStick size={13} aria-hidden="true" /><span>{memory}</span>
		</span>
		<span className="server-metric server-metric-network" aria-label={`${uploadLabel} · ${downloadLabel}`}
			title={[networkDetail, ratePending ? intl.formatMessage({ id: "serverMetrics.status.sampling" }) : "", detail].filter(Boolean).join(" · ")}>
			<Network size={13} aria-hidden="true" />
			<span aria-label={uploadLabel}><span aria-hidden="true">↑ </span>{upload}</span>
			<span aria-label={downloadLabel}><span aria-hidden="true">↓ </span>{download}</span>
		</span>
	</div>;
}

function formatPercent(value?: number): string {
	return value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function formatRate(value?: number | null): string {
	if (value === undefined || value === null) return "—";
	const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"];
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
