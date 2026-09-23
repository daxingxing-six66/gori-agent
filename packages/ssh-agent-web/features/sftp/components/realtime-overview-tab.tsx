"use client";

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
	return <div className="space-y-5">
		{monitoring.error ? <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><div><p className="text-[10px] font-semibold">{intl.formatMessage({ id: metrics ? "overview.monitor.paused" : "overview.monitor.failed" })}</p><p className="mt-1 text-[9px] leading-4">{monitoring.error.message} · {formatDateTime(monitoring.error.sampledAt, intl.locale)}</p></div></div> : null}
		<div className="grid gap-4 md:grid-cols-3">{cards.map((card) => { const Icon = card.icon; return <section key={card.label} className="ui-card p-5"><div className="flex items-center justify-between"><div className="grid h-9 w-9 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><Icon size={17} /></div><OverviewStatus streamState={streamState} hasMetrics={metrics !== undefined} hasError={monitoring.error !== undefined} /></div><p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{card.label}</p><div className="mt-1 flex items-end justify-between gap-3"><p className="text-2xl font-semibold">{card.value}</p><p className="pb-1 text-[10px] text-zinc-400">{card.detail}</p></div><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.min(100, card.usage)}%` }} /></div></section>; })}</div>
		<div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]"><section className="ui-card p-5"><h2 className="text-[13px] font-semibold">{intl.formatMessage({ id: "overview.connection.title" })}</h2><div className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">{[[intl.formatMessage({ id: "overview.connection.host" }), `${workspace.host.hostname}:${workspace.host.port}`], [intl.formatMessage({ id: "workspace.field.environment" }), intl.formatMessage({ id: `workspace.environment.${workspace.environment}`, defaultMessage: workspace.environment })], [intl.formatMessage({ id: "workspace.field.defaultCwd" }), workspace.defaultCwd], [intl.formatMessage({ id: "workspace.field.remoteDefaultCwd" }), workspace.remoteDefaultCwd ?? "/"], [intl.formatMessage({ id: "overview.connection.activeCredential" }), workspace.activeCredentialId], [intl.formatMessage({ id: "overview.connection.hostKey" }), workspace.host.hostKey?.fingerprint ?? intl.formatMessage({ id: "overview.connection.hostKey.pending" })], [intl.formatMessage({ id: "overview.connection.timeout" }), `${workspace.connection.connectTimeoutMs} ms`]].map(([label, value]) => <div key={label}><p className="text-[9px] uppercase tracking-[0.1em] text-zinc-400">{label}</p><p className="mt-1.5 truncate font-mono text-[11px] text-zinc-700">{value}</p></div>)}</div></section><section className="ui-card p-5"><div className="flex items-center justify-between"><div><h2 className="text-[13px] font-semibold">{intl.formatMessage({ id: "overview.pool.title" })}</h2><p className="mt-1 text-[10px] text-zinc-400">{intl.formatMessage({ id: "overview.pool.description" })}</p></div><RefreshCw size={15} className={streamState === "reconnecting" ? "animate-spin text-amber-600" : "text-zinc-400"} /></div><div className="mt-5 rounded-xl bg-[#f3f2ee] p-4"><div className="flex justify-between"><span className="font-mono text-[10px] text-zinc-400">{intl.formatMessage({ id: "overview.pool.generation" }, { count: connection?.generation ?? 0 })}</span><span className={`text-[9px] font-semibold ${connection?.state === "failed" ? "text-rose-600" : "text-[#397b5c]"}`}>{intl.formatMessage({ id: `overview.pool.state.${connection?.state ?? "idle"}`, defaultMessage: connection?.state ?? "idle" })}</span></div><div className="mt-4 grid grid-cols-3 text-center"><Stat value={connection?.activeChannels ?? 0} label={intl.formatMessage({ id: "overview.pool.active" })} /><Stat value={connection?.waitingChannels ?? 0} label={intl.formatMessage({ id: "overview.pool.waiting" })} /><Stat value={connection?.connectedAt ? elapsed(connection.connectedAt) : "—"} label={intl.formatMessage({ id: "overview.pool.uptime" })} /></div>{connection?.lastError ? <p className="mt-3 text-[9px] text-rose-600">{connection.lastError.message}</p> : null}</div></section></div>
		<section className="ui-card overflow-hidden"><header className="border-b border-zinc-100 px-5 py-4"><h2 className="text-[13px] font-semibold">{intl.formatMessage({ id: "overview.processes.title" })}</h2><p className="mt-1 text-[10px] text-zinc-400">{intl.formatMessage({ id: "overview.processes.description" })}</p></header>{metrics ? <div className="overflow-x-auto"><table className="w-full text-left text-[10px]"><thead className="text-zinc-400"><tr><th className="px-5 py-3">PID</th><th>{intl.formatMessage({ id: "overview.processes.user" })}</th><th>CPU</th><th>{intl.formatMessage({ id: "overview.memory" })}</th><th>RSS</th><th className="pr-5">{intl.formatMessage({ id: "overview.processes.command" })}</th></tr></thead><tbody>{metrics.processes.map((process) => <tr key={process.pid} className="border-t border-zinc-100"><td className="px-5 py-3 font-mono">{process.pid}</td><td>{process.user}</td><td>{process.cpuPercent}%</td><td>{process.memoryPercent}%</td><td>{formatBytes(process.residentBytes)}</td><td className="max-w-[520px] truncate pr-5 font-mono">{process.command}</td></tr>)}</tbody></table></div> : <p className="px-5 py-10 text-center text-[10px] text-zinc-400">{intl.formatMessage({ id: monitoring.error ? "overview.monitor.processUnavailable" : streamState === "reconnecting" ? "overview.monitor.recovering" : "overview.monitor.processLoading" })}</p>}</section>
	</div>;
}

function OverviewStatus({ streamState, hasMetrics, hasError }: { streamState: WorkspaceEventStreamState; hasMetrics: boolean; hasError: boolean }) {
	const intl = useIntl();
	const label = intl.formatMessage({ id: hasError ? (hasMetrics ? "overview.status.paused" : "overview.status.failed") : streamState === "connected" ? (hasMetrics ? "overview.status.live" : "overview.status.loading") : streamState === "reconnecting" ? "overview.status.reconnecting" : streamState === "closed" ? "overview.status.disconnected" : "overview.status.connecting" });
	const className = hasError ? "bg-amber-50 text-amber-700" : streamState === "connected" ? "bg-[#eaf2ec] text-[#397b5c]" : "bg-zinc-100 text-zinc-500";
	return <span className={`rounded-full px-2 py-0.5 text-[8px] font-semibold ${className}`}>{label}</span>;
}

function emptyMetricDetail(streamState: WorkspaceEventStreamState, hasError: boolean): string {
	if (hasError) return "—";
	if (streamState === "reconnecting") return "…";
	if (streamState === "closed") return "—";
	return "…";
}

function Stat({ value, label }: { value: string | number; label: string }) { return <div><p className="text-lg font-semibold">{value}</p><p className="mt-1 text-[8px] uppercase text-zinc-400">{label}</p></div>; }
function percent(value?: number): string { return value === undefined ? "—" : `${value.toFixed(1)}%`; }
function formatBytes(bytes: number): string { if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; return `${(bytes / 1024 ** 3).toFixed(1)} GiB`; }
function elapsed(since: number): string { const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`; }
function formatDateTime(timestamp: number, locale: string): string { return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(timestamp); }
