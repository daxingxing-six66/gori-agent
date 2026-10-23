"use client";

import { Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
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
	const diskRead = formatRate(metrics?.diskIo?.readBytesPerSecond);
	const diskWrite = formatRate(metrics?.diskIo?.writeBytesPerSecond);
	const status = intl.formatMessage({ id: `serverMetrics.status.${state.status}` });
	const uploadLabel = intl.formatMessage({ id: "serverMetrics.upload" }, { value: upload });
	const downloadLabel = intl.formatMessage({ id: "serverMetrics.download" }, { value: download });
	return <div className="server-metrics-details" data-state={state.status} role="group"
		aria-label={`${intl.formatMessage({ id: "serverMetrics.label" })} · ${status}`}>
		<dl>
			<div><dt><Cpu size={14} aria-hidden="true" />CPU</dt><dd>{cpu}</dd></div>
			<div><dt><MemoryStick size={14} aria-hidden="true" />{intl.formatMessage({ id: "serverMetrics.memoryLabel" })}</dt>
				<dd>{memory}{metrics ? <span className="server-metrics-capacity">{formatBytes(metrics.memory.usedBytes)} / {formatBytes(metrics.memory.totalBytes)}</span> : null}</dd></div>
			<div><dt><Network size={14} aria-hidden="true" />{intl.formatMessage({ id: "serverMetrics.networkLabel" })}</dt>
				<dd className="server-metrics-rates"><span aria-label={uploadLabel}>↑ {upload}</span><span aria-label={downloadLabel}>↓ {download}</span></dd></div>
			<div><dt><HardDrive size={14} aria-hidden="true" />{intl.formatMessage({ id: "serverMetrics.diskIoLabel" })}</dt>
				<dd className="server-metrics-rates">
					<span aria-label={intl.formatMessage({ id: "serverMetrics.diskReadLabel" }, { value: diskRead })}>{intl.formatMessage({ id: "serverMetrics.diskRead" }, { value: diskRead })}</span>
					<span aria-label={intl.formatMessage({ id: "serverMetrics.diskWriteLabel" }, { value: diskWrite })}>{intl.formatMessage({ id: "serverMetrics.diskWrite" }, { value: diskWrite })}</span>
				</dd></div>
		</dl>
		{state.error ? <p className="server-metrics-detail-error" role="alert">{state.error}</p> : null}
	</div>;
}

function formatPercent(value?: number): string {
	return value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function formatRate(value?: number | null): string {
	if (value === undefined || value === null) return "—";
	return `${formatBytes(value)}/s`;
}

function formatBytes(value: number): string {
	const units = ["B", "KiB", "MiB", "GiB"];
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
