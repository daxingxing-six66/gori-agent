"use client";

import Link from "next/link";
import { ArrowUpRight, Server } from "lucide-react";
import { useIntl } from "react-intl";
import type { StatisticsLocation } from "../model/statistics-location";
import { useStatistics } from "../runtime/use-statistics";
import { SortHeading, StatisticsEmpty, StatisticsError, StatisticsLoading, StatisticsUpdated, UsageCoverage, statisticsCoverage, useStatisticsFormat } from "./statistics-shared";

export function StatisticsWorkspacesTab({ query, refresh, retry, location, update }: {
	query: string; refresh: number; retry(): void; location: StatisticsLocation; update(patch: Partial<StatisticsLocation>): void;
}) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	const params = new URLSearchParams(query);
	params.set("sort", location.workspaceSort); params.set("direction", location.direction);
	const state = useStatistics("workspaces", params.toString(), refresh);
	const onSort = (key: string) => update({ workspaceSort: key, direction: key === location.workspaceSort && location.direction === "desc" ? "asc" : "desc" });
	if (state.loading) return <StatisticsLoading />;
	if (state.error || !state.data) return <StatisticsError retry={retry} />;
	const { rows, generatedAt } = state.data;
	const weight = (row: typeof rows[number]) => location.workspaceSort === "cost" ? row.usage.cost.total : location.workspaceSort === "runs" ? row.runs : location.workspaceSort === "calls" ? row.usage.calls : row.usage.totalTokens;
	const max = Math.max(1, ...rows.map(weight));
	return <div><div className="stats-table-toolbar"><span className="stats-counts">{intl.formatMessage({ id: "statistics.workspacesCount" }, { count: rows.length })}</span></div>
		{rows.length ? <div className="stats-table-wrap app-scrollbar"><table className="stats-table stats-workspaces-table"><thead><tr>
			<th scope="col">{intl.formatMessage({ id: "statistics.workspace" })}</th>
			<SortHeading labelId="statistics.runs" sortKey="runs" activeSort={location.workspaceSort} direction={location.direction} onSort={onSort} />
			<th scope="col" className="stats-number">{intl.formatMessage({ id: "statistics.activeDays" })}</th>
			<SortHeading labelId="statistics.calls" sortKey="calls" activeSort={location.workspaceSort} direction={location.direction} onSort={onSort} />
			<SortHeading labelId="statistics.tokens" sortKey="tokens" activeSort={location.workspaceSort} direction={location.direction} onSort={onSort} />
			<SortHeading labelId="statistics.cost" sortKey="cost" activeSort={location.workspaceSort} direction={location.direction} onSort={onSort} />
		</tr></thead><tbody>{rows.map((row) => <tr key={row.workspaceId}>
			<td><Link href={`/workspaces/${encodeURIComponent(row.workspaceId)}`} className="stats-workspace-link" aria-label={`${intl.formatMessage({ id: "statistics.openWorkspace" })} ${row.name}`}><Server size={15} /><div><strong>{row.name}</strong><span>{row.hostname}</span></div><ArrowUpRight size={13} /></Link>
				<div className="stats-share" aria-hidden="true"><span style={{ width: `${weight(row) / max * 100}%` }} /></div></td>
			<td className="stats-number">{format.exact(row.runs)}</td><td className="stats-number">{format.exact(row.activeDays)}</td>
			<td className="stats-number">{format.exact(row.usage.calls)}</td><td className="stats-number" title={format.exact(row.usage.totalTokens)}>{format.tokens(row.usage)}</td>
			<td className="stats-number stats-cost-value">{format.cost(row.usage)}</td>
		</tr>)}</tbody></table></div> : <StatisticsEmpty small />}
		<UsageCoverage usage={statisticsCoverage(rows)} />
		<StatisticsUpdated timestamp={generatedAt} timeZone={location.timeZone} />
	</div>;
}
