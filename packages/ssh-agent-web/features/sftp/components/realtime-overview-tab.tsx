"use client";

import { PageHeading } from "@/components/page-layout";
import "./overview-dashboard.css";
import { RemoteSandboxPanel } from "@/features/workspace/components/remote-sandbox-panel";
import { useState } from "react";
import { AlertTriangle, ChevronDown, Cpu, HardDrive, MemoryStick, RefreshCw } from "lucide-react";
import { useIntl } from "react-intl";
import type { Workspace } from "@/features/workspace/model/workspace";
import { applyMonitorError, applyMonitorSnapshot, type MonitoringState } from "../model/sftp-state";
import type { ConnectionPoolSnapshot, WorkspaceEventStreamState } from "../model/sftp";
import { useWorkspaceEvents } from "./use-workspace-events";

export function RealtimeOverviewTab({ workspace }: { workspace: Workspace }) {
	const intl = useIntl();
	const [monitoring, setMonitoring] = useState<MonitoringState>({});
	const [connection, setConnection] = useState<ConnectionPoolSnapshot>();
	const streamState = useWorkspaceEvents(workspace.id, ["monitoring", "connection", "transfers"], {
		onMetrics: (snapshot) => setMonitoring((current) => applyMonitorSnapshot(current, snapshot)),
		onMonitorError: (error) => setMonitoring((current) => applyMonitorError(current, error)),
		onConnection: setConnection,
	});
	const metrics = monitoring.snapshot;
	const rootFilesystem = metrics?.filesystems.find((item) => item.mountPoint === "/") ?? metrics?.filesystems[0];
	const cards = [
		{ label: "CPU", value: percent(metrics?.cpu.usagePercent), detail: metrics ? intl.formatMessage({ id: "overview.cpu.detail" }, { count: metrics.cpu.cores, load: metrics.cpu.loadAverage[0] }) : emptyMetricDetail(streamState, monitoring.error !== undefined), icon: Cpu, usage: metrics?.cpu.usagePercent ?? 0 },
		{ label: intl.formatMessage({ id: "overview.memory" }), value: percent(metrics?.memory.usagePercent), detail: metrics ? `${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)}` : emptyMetricDetail(streamState, monitoring.error !== undefined), icon: MemoryStick, usage: metrics?.memory.usagePercent ?? 0 },
		{ label: intl.formatMessage({ id: "overview.disk" }), value: percent(rootFilesystem?.usagePercent), detail: rootFilesystem ? `${formatBytes(rootFilesystem.usedBytes)} / ${formatBytes(rootFilesystem.totalBytes)}` : emptyMetricDetail(streamState, monitoring.error !== undefined), icon: HardDrive, usage: rootFilesystem?.usagePercent ?? 0 },
	];

	const connectionDetails = [
		[intl.formatMessage({ id: "overview.connection.host" }), workspace.host.hostname + ":" + workspace.host.port],
		[intl.formatMessage({ id: "workspace.field.environment" }), intl.formatMessage({ id: `workspace.environment.${workspace.environment}`, defaultMessage: workspace.environment })],
		[intl.formatMessage({ id: "workspace.field.defaultCwd" }), workspace.defaultCwd],
		[intl.formatMessage({ id: "overview.connection.activeCredential" }), workspace.activeCredentialId],
		[intl.formatMessage({ id: "overview.connection.hostKey" }), workspace.host.hostKey?.fingerprint ?? intl.formatMessage({ id: "overview.connection.hostKey.pending" })],
		[intl.formatMessage({ id: "overview.connection.timeout" }), workspace.connection.connectTimeoutMs + " ms"],
	];

	return (
		<div className="overview-dashboard">
			<PageHeading title={intl.formatMessage({ id: "overview.title" })} description={intl.formatMessage({ id: "overview.description" })} actions={<OverviewStatus streamState={streamState} hasMetrics={metrics !== undefined} hasError={monitoring.error !== undefined} />} />
			{monitoring.error ? (
				<div className="dashboard-monitor-error" role="status">
					<AlertTriangle size={14} aria-hidden="true" />
					<div><p className="font-medium">{intl.formatMessage({ id: metrics ? "overview.monitor.paused" : "overview.monitor.failed" })}</p><p className="mt-1 break-words">{monitoring.error.message} · {formatDateTime(monitoring.error.sampledAt, intl.locale)}</p></div>
				</div>
			) : null}
			<div className="dashboard-metrics">
				{cards.map((card) => {
					const Icon = card.icon;
					return <section key={card.label} className="ui-card dashboard-metric">
						<h3><Icon size={14} aria-hidden="true" />{card.label}</h3>
						<p className="dashboard-metric-value">{card.value}</p>
						<p className="dashboard-metric-detail">{card.detail}</p>
						<div className="dashboard-meter" aria-hidden="true"><div style={{ width: Math.max(0, Math.min(100, card.usage)) + "%" }} /></div>
					</section>;
				})}
			</div>
			<div className="dashboard-body">
				<section className="ui-card dashboard-processes">
					<header className="page-section-header"><div>
						<h3>{intl.formatMessage({ id: "overview.processes.title" })}</h3>
						<p>{intl.formatMessage({ id: "overview.processes.description" })}</p>
					</div></header>
					{metrics ? (
						<div className="overflow-x-auto">
							<table className="dashboard-process-table">
								<thead className="bg-[var(--surface-muted)] text-[var(--text-muted)]"><tr>
									<th className="px-5 py-2.5 font-medium">PID</th>
									<th className="py-2.5 font-medium">{intl.formatMessage({ id: "overview.processes.user" })}</th>
									<th className="py-2.5 font-medium">CPU</th>
									<th className="py-2.5 font-medium">{intl.formatMessage({ id: "overview.memory" })}</th>
									<th className="py-2.5 font-medium">RSS</th>
									<th className="py-2.5 pr-5 font-medium">{intl.formatMessage({ id: "overview.processes.command" })}</th>
								</tr></thead>
								<tbody>{metrics.processes.map((process) => (
									<tr key={process.pid} className="border-t border-[var(--line-soft)] text-[var(--text-secondary)]">
										<td className="px-5 py-2.5 font-mono tabular-nums">{process.pid}</td>
										<td className="truncate" title={process.user}>{process.user}</td>
										<td className="tabular-nums">{process.cpuPercent}%</td>
										<td className="tabular-nums">{process.memoryPercent}%</td>
										<td className="tabular-nums">{formatBytes(process.residentBytes)}</td>
										<td className="max-w-[520px] truncate pr-5 font-mono" title={process.command}>{process.command}</td>
									</tr>
								))}</tbody>
							</table>
						</div>
					) : (
						<p className="px-5 py-10 text-center text-[12px] text-[var(--text-muted)]">{intl.formatMessage({ id: monitoring.error ? "overview.monitor.processUnavailable" : streamState === "reconnecting" ? "overview.monitor.recovering" : "overview.monitor.processLoading" })}</p>
					)}
				</section>
				<aside className="dashboard-diagnostics">
					<section className="ui-card dashboard-pool">
						<div className="flex items-center justify-between gap-3"><h3>{intl.formatMessage({ id: "overview.pool.title" })}</h3><RefreshCw size={13} className={streamState === "reconnecting" ? "animate-spin text-[var(--warning)]" : "text-[var(--text-faint)]"} aria-hidden="true" /></div>
						<div className="dashboard-pool-state" data-state={connection?.state ?? "idle"}><span>{intl.formatMessage({ id: `overview.pool.state.${connection?.state ?? "idle"}`, defaultMessage: connection?.state ?? "idle" })}</span><span>{intl.formatMessage({ id: "overview.pool.generation" }, { count: connection?.generation ?? 0 })}</span></div>
						<div className="dashboard-pool-stats">
							<Stat value={connection?.activeChannels ?? 0} label={intl.formatMessage({ id: "overview.pool.active" })} />
							<Stat value={connection?.waitingChannels ?? 0} label={intl.formatMessage({ id: "overview.pool.waiting" })} />
							<Stat value={connection?.connectedAt ? elapsed(connection.connectedAt) : "—"} label={intl.formatMessage({ id: "overview.pool.uptime" })} />
						</div>
						<p className="dashboard-pool-description">{intl.formatMessage({ id: "overview.pool.description" })}</p>
						{connection?.lastError ? <p className="mt-3 break-words text-[12px] text-[var(--danger)]">{connection.lastError.message}</p> : null}
					</section>
					<RemoteSandboxPanel key={workspace.id + ":" + workspace.revision} workspace={workspace} />
				</aside>
			</div>
			<details className="ui-card dashboard-connection">
				<summary><span>{intl.formatMessage({ id: "overview.connection.title" })}</span><span className="dashboard-connection-host">{workspace.host.hostname}:{workspace.host.port}</span><ChevronDown size={14} aria-hidden="true" /></summary>
				<dl>{connectionDetails.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>
			</details>
		</div>
	);
}

function OverviewStatus({ streamState, hasMetrics, hasError }: { streamState: WorkspaceEventStreamState; hasMetrics: boolean; hasError: boolean }) {
	const intl = useIntl();
	const label = intl.formatMessage({ id: hasError ? (hasMetrics ? "overview.status.paused" : "overview.status.failed") : streamState === "connected" ? (hasMetrics ? "overview.status.live" : "overview.status.loading") : streamState === "reconnecting" ? "overview.status.reconnecting" : streamState === "closed" ? "overview.status.disconnected" : "overview.status.connecting" });
	const className = hasError ? "bg-[var(--warning-soft)] text-[var(--warning)]" : streamState === "connected" && hasMetrics ? "bg-[var(--accent-soft)] text-[var(--accent-ink)]" : "bg-[var(--surface-muted)] text-[var(--text-muted)]";
	return <span className={`dashboard-live-status ${className}`}><span aria-hidden="true" />{label}</span>;
}

function emptyMetricDetail(streamState: WorkspaceEventStreamState, hasError: boolean): string {
	if (hasError) return "—";
	if (streamState === "reconnecting") return "…";
	if (streamState === "closed") return "—";
	return "…";
}

function Stat({ value, label }: { value: string | number; label: string }) { return <div><p className="text-[19px] font-semibold tabular-nums text-[var(--ink)]">{value}</p><p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">{label}</p></div>; }
function percent(value?: number): string { return value === undefined ? "—" : `${value.toFixed(1)}%`; }
function formatBytes(bytes: number): string { if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; return `${(bytes / 1024 ** 3).toFixed(1)} GiB`; }
function elapsed(since: number): string { const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`; }
function formatDateTime(timestamp: number, locale: string): string { return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(timestamp); }
