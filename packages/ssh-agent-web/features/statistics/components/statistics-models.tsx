"use client";

import { useIntl } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import type { StatisticsLocation } from "../model/statistics-location";
import type { StatisticsModelRow } from "../model/statistics";
import { useStatistics } from "../runtime/use-statistics";
import { SortHeading, StatisticsEmpty, StatisticsError, StatisticsLoading, StatisticsUpdated, UsageCoverage, statisticsCoverage, useStatisticsFormat } from "./statistics-shared";

export function StatisticsModelsTab({ query, refresh, retry, location, update }: {
	query: string; refresh: number; retry(): void; location: StatisticsLocation; update(patch: Partial<StatisticsLocation>): void;
}) {
	const intl = useIntl();
	const params = new URLSearchParams(query);
	params.set("sort", location.modelSort); params.set("direction", location.direction);
	const state = useStatistics("models", params.toString(), refresh);
	const onSort = (key: string) => update({ modelSort: key, direction: key === location.modelSort && location.direction === "desc" ? "asc" : "desc" });
	if (state.loading) return <StatisticsLoading />;
	if (state.error || !state.data) return <StatisticsError retry={retry} />;
	const { rows, generatedAt } = state.data;
	return <div>
		<div className="stats-table-toolbar"><div className="stats-counts"><span>{intl.formatMessage({ id: "statistics.modelsCount" }, { count: rows.length })}</span><span>{intl.formatMessage({ id: "statistics.providersCount" }, { count: new Set(rows.map((row) => row.providerId)).size })}</span></div>
			<div className="stats-inline-sort"><span>{intl.formatMessage({ id: "statistics.sortBy" })}</span><div className="stats-select-compact"><CustomSelect compact ariaLabel={intl.formatMessage({ id: "statistics.sortBy" })} value={location.modelSort} onChange={onSort}
				options={(["cost", "tokens", "calls"] as const).map((value) => ({ value, label: intl.formatMessage({ id: `statistics.${value}` }) }))} /></div></div>
		</div>
		{rows.length ? <StatisticsModelsTable rows={rows} sort={location.modelSort} direction={location.direction} onSort={onSort} /> : <StatisticsEmpty small />}
		<UsageCoverage usage={statisticsCoverage(rows)} />
		<StatisticsUpdated timestamp={generatedAt} timeZone={location.timeZone} />
	</div>;
}

export function StatisticsModelsTable({ rows, sort, direction, onSort }: { rows: StatisticsModelRow[]; sort: string; direction: string; onSort(key: string): void }) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	return <div className="stats-table-wrap app-scrollbar"><table className="stats-table stats-models-table">
		<thead><tr><th scope="col">{intl.formatMessage({ id: "statistics.model" })}</th>
			<SortHeading labelId="statistics.calls" sortKey="calls" activeSort={sort} direction={direction} onSort={onSort} />
			{(["input", "cacheRead", "cacheWrite", "output"] as const).map((key) => <th scope="col" className="stats-number" key={key}>{intl.formatMessage({ id: `statistics.${key}` })}</th>)}
			<SortHeading labelId="statistics.cost" sortKey="cost" activeSort={sort} direction={direction} onSort={onSort} />
		</tr></thead><tbody>{rows.map((row, index) => <tr key={JSON.stringify([row.providerId, row.modelId])}>
			<td><div className="stats-model-name"><span className="stats-model-mark" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div><strong title={row.modelId}>{row.modelId}</strong><span>{row.providerId}</span></div></div></td>
			<td className="stats-number">{format.exact(row.usage.calls)}</td>
			{(["input", "cacheRead", "cacheWrite", "output"] as const).map((key) => <td className="stats-number" key={key} title={row.usage.usageSamples ? format.exact(row.usage[key]) : intl.formatMessage({ id: "statistics.unknown" })}>{row.usage.usageSamples ? format.compact(row.usage[key]) : "—"}</td>)}
			<td className="stats-number stats-cost-value">{format.cost(row.usage)}</td>
		</tr>)}</tbody>
	</table></div>;
}
