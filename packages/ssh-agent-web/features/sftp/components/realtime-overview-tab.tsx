"use client";

import { RemoteSandboxPanel } from "@/features/workspace/components/remote-sandbox-panel";
import { useState } from "react";
import { AlertTriangle, Cpu, HardDrive, MemoryStick, RefreshCw } from "lucide-react";
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
		[intl.formatMessage({ id: "workspace.field.remoteDefaultCwd" }), workspace.remoteDefaultCwd ?? "/"],
		[intl.formatMessage({ id: "overview.connection.activeCredential" }), workspace.activeCredentialId],
		[intl.formatMessage({ id: "overview.connection.hostKey" }), workspace.host.hostKey?.fingerprint ?? intl.formatMessage({ id: "overview.connection.hostKey.pending" })],
		[intl.formatMessage({ id: "overview.connection.timeout" }), workspace.connection.connectTimeoutMs + " ms"],
	];

	return (
		<div className="space-y-5">
			{monitoring.error ? (
				<div className="flex items-start gap-3 rounded-xl border border-[var(--warning-line)] bg-[var(--warning-soft)] px-4 py-3 text-[var(--warning)]" role="status">
					<AlertTriangle size={16} className="mt-0.5 shrink-0" />
					<div className="min-w-0">
						<p className="text-[12px] font-semibold">{intl.formatMessage({ id: metrics ? "overview.monitor.paused" : "overview.monitor.failed" })}</p>
						<p className="mt-1 break-words text-[12px] leading-5">{monitoring.error.message} · {formatDateTime(monitoring.error.sampledAt, intl.locale)}</p>
					</div>
				</div>
			) : null}
			<section className="ui-card overflow-hidden">
				<header className="flex items-center justify-between gap-4 border-b border-[var(--line-soft)] px-5 py-4">
					<h2 className="text-[14px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "workspace.tabs.overview" })}</h2>
					<OverviewStatus streamState={streamState} hasMetrics={metrics !== undefined} hasError={monitoring.error !== undefined} />
				</header>
				<div className="grid md:grid-cols-3">
					{cards.map((card) => {
						const Icon = card.icon;
						return (
							<div key={card.label} className="overview-metric px-5 py-4">
								<div className="flex items-center gap-2 text-[var(--text-muted)]">
									<Icon size={16} strokeWidth={1.8} aria-hidden="true" />
									<p className="text-[12px] font-medium">{card.label}</p>
								</div>
								<p className="mt-3 text-[25px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[var(--ink)]">{card.value}</p>
								<p className="mt-2 min-h-5 text-[12px] leading-5 text-[var(--text-muted)]">{card.detail}</p>
								<div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--surface-hover)]" aria-hidden="true">
									<div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: Math.min(100, card.usage) + "%" }} />
								</div>
							</div>
						);
					})}
				</div>
			</section>
			<div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
				<section className="ui-card p-5">
					<h2 className="text-[14px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "overview.connection.title" })}</h2>
					<dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
						{connectionDetails.map(([label, value]) => (
							<div key={label} className="min-w-0">
								<dt className="text-[12px] text-[var(--text-muted)]">{label}</dt>
								<dd className="mt-1 break-all font-mono text-[12px] leading-5 text-[var(--text-secondary)]" title={value}>{value}</dd>
							</div>
						))}
					</dl>
				</section>
				<section className="ui-card p-5">
					<div className="flex items-start justify-between gap-3">
						<div>
							<h2 className="text-[14px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "overview.pool.title" })}</h2>
							<p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{intl.formatMessage({ id: "overview.pool.description" })}</p>
						</div>
						<RefreshCw size={15} className={streamState === "reconnecting" ? "mt-0.5 shrink-0 animate-spin text-[var(--warning)]" : "mt-0.5 shrink-0 text-[var(--text-faint)]"} aria-hidden="true" />
					</div>
					<div className="mt-5 flex items-center justify-between gap-3 border-y border-[var(--line-soft)] py-3">
						<span className="font-mono text-[12px] text-[var(--text-muted)]">{intl.formatMessage({ id: "overview.pool.generation" }, { count: connection?.generation ?? 0 })}</span>
						<span className={"text-[12px] font-medium " + (connection?.state === "failed" ? "text-[var(--danger)]" : "text-[var(--accent-ink)]")}>{intl.formatMessage({ id: `overview.pool.state.${connection?.state ?? "idle"}`, defaultMessage: connection?.state ?? "idle" })}</span>
					</div>
					<div className="mt-5 grid grid-cols-3 gap-3 text-center">
						<Stat value={connection?.activeChannels ?? 0} label={intl.formatMessage({ id: "overview.pool.active" })} />
						<Stat value={connection?.waitingChannels ?? 0} label={intl.formatMessage({ id: "overview.pool.waiting" })} />
						<Stat value={connection?.connectedAt ? elapsed(connection.connectedAt) : "—"} label={intl.formatMessage({ id: "overview.pool.uptime" })} />
					</div>
					{connection?.lastError ? <p className="mt-4 break-words text-[12px] leading-5 text-[var(--danger)]">{connection.lastError.message}</p> : null}
				</section>
			</div>
			<RemoteSandboxPanel key={workspace.id + ":" + workspace.revision} workspace={workspace} />
			<section className="ui-card overflow-hidden">
				<header className="border-b border-[var(--line-soft)] px-5 py-4">
					<h2 className="text-[14px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "overview.processes.title" })}</h2>
					<p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{intl.formatMessage({ id: "overview.processes.description" })}</p>
				</header>
				{metrics ? (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[640px] text-left text-[12px]">
							<thead className="bg-[var(--surface-muted)] text-[var(--text-muted)]"><tr>
								<th className="px-5 py-3 font-medium">PID</th>
								<th className="py-3 font-medium">{intl.formatMessage({ id: "overview.processes.user" })}</th>
								<th className="py-3 font-medium">CPU</th>
								<th className="py-3 font-medium">{intl.formatMessage({ id: "overview.memory" })}</th>
								<th className="py-3 font-medium">RSS</th>
								<th className="py-3 pr-5 font-medium">{intl.formatMessage({ id: "overview.processes.command" })}</th>
							</tr></thead>
							<tbody>{metrics.processes.map((process) => (
								<tr key={process.pid} className="border-t border-[var(--line-soft)] text-[var(--text-secondary)]">
									<td className="px-5 py-3 font-mono tabular-nums">{process.pid}</td>
									<td>{process.user}</td>
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
		</div>
	);
}

function OverviewStatus({ streamState, hasMetrics, hasError }: { streamState: WorkspaceEventStreamState; hasMetrics: boolean; hasError: boolean }) {
	const intl = useIntl();
	const label = intl.formatMessage({ id: hasError ? (hasMetrics ? "overview.status.paused" : "overview.status.failed") : streamState === "connected" ? (hasMetrics ? "overview.status.live" : "overview.status.loading") : streamState === "reconnecting" ? "overview.status.reconnecting" : streamState === "closed" ? "overview.status.disconnected" : "overview.status.connecting" });
	const className = hasError ? "bg-[var(--warning-soft)] text-[var(--warning)]" : streamState === "connected" && hasMetrics ? "bg-[var(--accent-soft)] text-[var(--accent-ink)]" : "bg-[var(--surface-muted)] text-[var(--text-muted)]";
	return <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${className}`}>{label}</span>;
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
