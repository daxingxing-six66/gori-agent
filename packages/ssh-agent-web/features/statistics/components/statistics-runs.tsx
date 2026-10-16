"use client";

import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, ArrowUpRight } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import type { StatisticsLocation } from "../model/statistics-location";
import type { StatisticsRunStatus } from "../model/statistics";
import { useStatistics } from "../runtime/use-statistics";
import { StatisticsEmpty, StatisticsError, StatisticsLoading, StatisticsMetric, StatisticsUpdated, UsageBreakdown, UsageCoverage, useStatisticsFormat } from "./statistics-shared";

export function StatisticsRunsTab({ query, refresh, retry, location, update }: {
	query: string; refresh: number; retry(): void; location: StatisticsLocation; update(patch: Partial<StatisticsLocation>): void;
}) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	const params = new URLSearchParams(query);
	if (location.status) params.set("status", location.status);
	if (location.cursor) params.set("cursor", location.cursor);
	const records = useStatistics("run-records", params.toString(), refresh);
	const summaryState = useStatistics("runs", query, refresh);
	const [expanded, setExpanded] = useState<string | null>(null);
	const trail = useRef<string[]>([]);
	const base = `${query}&status=${location.status}`;
	const trailKey = useRef(base);
	if (trailKey.current !== base) { trail.current = []; trailKey.current = base; }
	if (records.loading && summaryState.loading) return <StatisticsLoading />;
	const summary = summaryState.data?.summary;
	return <div>
		{summaryState.error ? <StatisticsError retry={retry} /> : summary && <div className="stats-run-summary">
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.runs" })} value={format.exact(summary.total)} />
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.completionRate" })} value={summary.completionRate === null ? "—" : intl.formatNumber(summary.completionRate, { style: "percent", maximumFractionDigits: 1 })} />
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.averageDuration" })} value={format.duration(summary.averageDurationMs)} />
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.longestDuration" })} value={format.duration(summary.longestDurationMs)} />
		</div>}
		<p className="stats-caption">{intl.formatMessage({ id: "statistics.durationHint" })}</p>
		<div className="stats-table-toolbar"><p className="stats-caption">{intl.formatMessage({ id: "statistics.runAttribution" })}</p>
			<div className="stats-select-compact"><CustomSelect compact ariaLabel={intl.formatMessage({ id: "statistics.status" })} value={location.status} onChange={(status) => update({ status })} options={[
				{ value: "", label: intl.formatMessage({ id: "statistics.allStatuses" }) },
				...(["pending", "running", "completed", "failed", "cancelled"] as StatisticsRunStatus[]).map((status) => ({ value: status, label: intl.formatMessage({ id: `statistics.status.${status}` }) })),
			]} /></div>
		</div>
		{records.loading ? <StatisticsLoading /> : records.error || !records.data ? <StatisticsError retry={retry} /> : <>
			{records.data.rows.length ? <div className="stats-table-wrap app-scrollbar"><table className="stats-table stats-runs-table"><thead><tr>
				<th scope="col"><span className="sr-only">{intl.formatMessage({ id: "statistics.details" })}</span></th>
				{(["time", "session", "workspace", "model", "status", "duration", "tokens", "cost"] as const).map((key) => <th scope="col" key={key} className={["duration", "tokens", "cost"].includes(key) ? "stats-number" : undefined}>{intl.formatMessage({ id: `statistics.${key}` })}</th>)}
			</tr></thead><tbody>{records.data.rows.map((row) => <Fragment key={row.id}><tr>
				<td><button type="button" className="stats-expand" aria-label={`${intl.formatMessage({ id: "statistics.details" })} ${row.sessionName}`} aria-expanded={expanded === row.id} aria-controls={`stats-run-${row.id}`} onClick={() => setExpanded(expanded === row.id ? null : row.id)}><ChevronDown size={14} style={{ transform: expanded === row.id ? "rotate(180deg)" : undefined }} /></button></td>
				<td className="stats-time">{intl.formatDate(row.createdAt, { month: "short", day: "numeric", timeZone: location.timeZone })}<span>{intl.formatTime(row.createdAt, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: location.timeZone })}</span></td>
				<td><Link className="stats-session-link" href={`/sessions/${encodeURIComponent(row.sessionId)}`} title={row.sessionName}>{row.sessionName}</Link></td>
				<td><span className="stats-cell-name" title={row.workspaceName}>{row.workspaceName}</span></td><td><strong className="stats-cell-name" title={row.modelId}>{row.modelId}</strong><span className="stats-cell-secondary">{row.providerId}</span></td>
				<td><span className="stats-status" data-status={row.status}><i />{intl.formatMessage({ id: `statistics.status.${row.status}` })}</span></td>
				<td className="stats-number">{format.duration(row.durationMs)}</td><td className="stats-number" title={format.exact(row.usage.totalTokens)}>{format.tokens(row.usage)}</td><td className="stats-number stats-cost-value">{format.cost(row.usage)}</td>
			</tr>{expanded === row.id && <tr className="stats-expanded-row" id={`stats-run-${row.id}`}><td colSpan={9}><div className="stats-run-detail">
				<UsageBreakdown usage={row.usage} /><UsageBreakdown usage={row.usage} costs />
				{row.failure && <div className="stats-run-failure"><strong>{intl.formatMessage({ id: "statistics.failure" })}</strong><code>{row.failure.code}</code><p>{row.failure.message}</p></div>}
				<UsageCoverage usage={row.usage} /><Link className="page-button" href={`/sessions/${encodeURIComponent(row.sessionId)}`}>{intl.formatMessage({ id: "statistics.openSession" })}<ArrowUpRight size={13} /></Link>
			</div></td></tr>}</Fragment>)}</tbody></table></div> : <StatisticsEmpty small />}
			<div className="stats-pagination"><span>{intl.formatMessage({ id: "statistics.pageSize" })}</span><div>
				<button type="button" className="page-button" disabled={!location.cursor} onClick={() => { const cursor = trail.current.pop() ?? ""; update({ cursor }); }}><ChevronLeft size={13} />{intl.formatMessage({ id: trail.current.length ? "statistics.previous" : "statistics.first" })}</button>
				<button type="button" className="page-button" disabled={!records.data.nextCursor} onClick={() => { trail.current.push(location.cursor); update({ cursor: records.data!.nextCursor ?? "" }); }}>
					{intl.formatMessage({ id: "statistics.next" })}<ChevronRight size={13} /></button>
			</div></div><StatisticsUpdated timestamp={records.data.generatedAt} timeZone={location.timeZone} />
		</>}
	</div>;
}
