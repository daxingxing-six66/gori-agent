"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { useRef } from "react";
import { useIntl } from "react-intl";
import type { StatisticsCallRow } from "../model/statistics";
import type { StatisticsLocation } from "../model/statistics-location";
import { useStatistics } from "../runtime/use-statistics";
import { StatisticsEmpty, StatisticsError, StatisticsLoading, StatisticsUpdated, useStatisticsFormat } from "./statistics-shared";

export function StatisticsCallsTab({ query, refresh, retry, location, update }: {
	query: string; refresh: number; retry(): void; location: StatisticsLocation; update(patch: Partial<StatisticsLocation>): void;
}) {
	const intl = useIntl();
	const params = new URLSearchParams(query);
	if (location.cursor) params.set("cursor", location.cursor);
	const records = useStatistics("call-records", params.toString(), refresh);
	const trail = useRef<string[]>([]);
	const trailKey = useRef(query);
	if (trailKey.current !== query) { trail.current = []; trailKey.current = query; }
	return <div>
		<div className="stats-cache-explanation"><Info size={15} aria-hidden="true" /><div>
			<p>{intl.formatMessage({ id: "statistics.cacheFormula" })}</p>
			<p>{intl.formatMessage({ id: "statistics.cacheSourceHint" })}</p>
			<p>{intl.formatMessage({ id: "statistics.cacheLegacyCompaction" })}</p>
		</div></div>
		{records.loading ? <StatisticsLoading /> : records.error || !records.data ? <StatisticsError retry={retry} /> : <>
			{records.data.rows.length ? <StatisticsCallsTable rows={records.data.rows} timeZone={location.timeZone} /> : <StatisticsEmpty small />}
			<div className="stats-pagination"><span>{intl.formatMessage({ id: "statistics.pageSize" })}</span><div>
				<button type="button" className="page-button" disabled={!location.cursor} onClick={() => update({ cursor: trail.current.pop() ?? "" })}>
					<ChevronLeft size={13} />{intl.formatMessage({ id: trail.current.length ? "statistics.previous" : "statistics.first" })}</button>
				<button type="button" className="page-button" disabled={!records.data.nextCursor} onClick={() => { trail.current.push(location.cursor); update({ cursor: records.data!.nextCursor ?? "" }); }}>
					{intl.formatMessage({ id: "statistics.next" })}<ChevronRight size={13} /></button>
			</div></div><StatisticsUpdated timestamp={records.data.generatedAt} timeZone={location.timeZone} />
		</>}
	</div>;
}

export function StatisticsCallsTable({ rows, timeZone }: { rows: StatisticsCallRow[]; timeZone: string }) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	const rate = (value: number) => {
		const lowerBound = value > 0 && value < .0001;
		const upperBound = value < 1 && value > .9999;
		return `${lowerBound ? "<" : upperBound ? ">" : ""}${intl.formatNumber(lowerBound ? .0001 : upperBound ? .9999 : value, { style: "percent", maximumFractionDigits: 2 })}`;
	};
	return <div className="stats-table-wrap app-scrollbar"><table className="stats-table stats-calls-table">
		<caption className="sr-only">{intl.formatMessage({ id: "statistics.description.calls" })}</caption>
		<thead><tr>{(["time", "session", "workspace", "model", "callKind", "apiInput", "cacheHitTokens", "cacheHitRate"] as const).map(key =>
			<th scope="col" key={key} className={["apiInput", "cacheHitTokens", "cacheHitRate"].includes(key) ? "stats-number" : undefined}>{intl.formatMessage({ id: `statistics.${key}` })}</th>)}</tr></thead>
		<tbody>{rows.map(row => {
			const reported = row.cache.status === "reported";
			const missing = intl.formatMessage({ id: row.cache.status === "invalid" ? "statistics.cacheInvalid" : "statistics.cacheUnreported" });
			const hint = intl.formatMessage({ id: reported ? row.cache.inputTokens === 0 ? "statistics.cacheZeroInput" : "statistics.cacheReported" : row.cache.status === "invalid" ? "statistics.cacheInvalidHint" : "statistics.cacheUnreportedHint" });
			return <tr key={row.id}>
				<td className="stats-time">{intl.formatDate(row.createdAt, { month: "short", day: "numeric", timeZone })}<span>{intl.formatTime(row.createdAt, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone })}</span></td>
				<td><Link className="stats-session-link" href={`/sessions/${encodeURIComponent(row.sessionId)}`} title={row.sessionName}>{row.sessionName}</Link></td>
				<td><span className="stats-cell-name" title={row.workspaceName}>{row.workspaceName}</span></td>
				<td><strong className="stats-cell-name" title={row.modelId}>{row.modelId}</strong><span className="stats-cell-secondary">{row.providerId}</span></td>
				<td><span className="stats-status">{intl.formatMessage({ id: `statistics.callKind.${row.kind}` })}</span></td>
				<td className="stats-number">{reported && row.cache.inputTokens !== null ? format.exact(row.cache.inputTokens) : "—"}</td>
				<td className="stats-number">{reported && row.cache.cachedTokens !== null ? format.exact(row.cache.cachedTokens) : "—"}</td>
				<td className="stats-number stats-cache-rate" title={hint}>
					{reported && row.cache.hitRate !== null ? <strong>{rate(row.cache.hitRate)}</strong> : reported ? <><span>—</span><span className="stats-cell-secondary">{intl.formatMessage({ id: "statistics.cacheZeroInputLabel" })}</span></> : <span className="stats-cache-unavailable">{missing}</span>}
				</td>
			</tr>;
		})}</tbody>
	</table></div>;
}
