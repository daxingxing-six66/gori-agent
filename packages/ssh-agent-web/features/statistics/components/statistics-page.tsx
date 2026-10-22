"use client";

import { useRef, useState } from "react";
import { Activity, BarChart3, Clock3, Layers3, RotateCw, Server } from "lucide-react";
import { useIntl } from "react-intl";
import { PageHeader } from "@/components/page-layout";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { CustomSelect } from "@/components/custom-select";
import { localDay, statisticsParams, statisticsTabs, type StatisticsLocation, type StatisticsTab } from "../model/statistics-location";
import { useStatistics, useStatisticsLocation } from "../runtime/use-statistics";
import { StatisticsOverviewTab } from "./statistics-overview";
import { StatisticsModelsTab } from "./statistics-models";
import { StatisticsRunsTab } from "./statistics-runs";
import { StatisticsCallsTab } from "./statistics-calls";
import { StatisticsWorkspacesTab } from "./statistics-workspaces";
import { StatisticsModelFilters } from "./statistics-model-filters";
import { StatisticsError, StatisticsLoading } from "./statistics-shared";
import "./statistics.css";

const icons = { overview: BarChart3, models: Layers3, calls: Activity, runs: Clock3, workspaces: Server };

export function StatisticsPage() {
	const intl = useIntl();
	const { location, update } = useStatisticsLocation();
	return <div className="app-layout stats-page"><WorkspaceSidebar activeStatistics />
		<main className="page-main page-main-workspace">
			<PageHeader compact title={intl.formatMessage({ id: "statistics.title" })} actions={<Activity size={15} className="stats-header-icon" aria-hidden="true" />} />
			{location ? <StatisticsContent location={location} update={update} /> : <div className="page-content"><StatisticsLoading /></div>}
		</main>
	</div>;
}

function StatisticsContent({ location, update }: { location: StatisticsLocation; update(patch: Partial<StatisticsLocation>): void }) {
	const intl = useIntl();
	const [refresh, setRefresh] = useState(0);
	const retry = () => setRefresh((value) => value + 1);
	const options = useStatistics("options", "", refresh);
	const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
	const now = Date.now();
	const params = statisticsParams(location, now);
	const query = params?.toString() ?? null;
	const currentYear = Number(localDay(now, location.timeZone).slice(0, 4));
	const firstYear = options.data?.earliestAt === null || !options.data ? currentYear : Number(localDay(options.data.earliestAt, location.timeZone).slice(0, 4));
	const years = Array.from({ length: Math.max(1, currentYear - Math.min(firstYear, location.year) + 1) }, (_, index) => currentYear - index);
	if (!years.includes(location.year)) years.unshift(location.year);
	const switchTab = (tab: StatisticsTab) => update({ tab });
	const shared = { query: query ?? "", refresh, retry };
	return <>
		<div className="page-tabs stats-tabs app-scrollbar" role="tablist" aria-label={intl.formatMessage({ id: "statistics.title" })}>
			{statisticsTabs.map((tab, index) => {
				const Icon = icons[tab];
				return <button type="button" role="tab" key={tab} id={`stats-tab-${tab}`} aria-controls={`stats-panel-${tab}`} aria-selected={location.tab === tab} tabIndex={location.tab === tab ? 0 : -1} className="page-tab"
					ref={(element) => { tabButtons.current[index] = element; }} onClick={() => switchTab(tab)} onKeyDown={(event) => {
						const next = event.key === "ArrowRight" ? (index + 1) % statisticsTabs.length : event.key === "ArrowLeft" ? (index + statisticsTabs.length - 1) % statisticsTabs.length : event.key === "Home" ? 0 : event.key === "End" ? statisticsTabs.length - 1 : null;
						if (next !== null) { event.preventDefault(); switchTab(statisticsTabs[next]); tabButtons.current[next]?.focus(); }
					}}><Icon size={14} aria-hidden="true" />{intl.formatMessage({ id: `statistics.tab.${tab}` })}</button>;
			})}
		</div>
		<div className="page-content stats-content app-scrollbar"><div className="stats-content-inner">
			<div className="stats-page-heading"><div><h2>{intl.formatMessage({ id: `statistics.tab.${location.tab}` })}</h2><p>{intl.formatMessage({ id: `statistics.description.${location.tab}` })}</p></div>
				<button type="button" className="page-button stats-refresh" onClick={retry}><RotateCw size={14} />{intl.formatMessage({ id: "statistics.refresh" })}</button>
			</div>
			<div className="stats-filters">
				<div className="stats-filter"><span>{intl.formatMessage({ id: "statistics.range" })}</span><CustomSelect compact ariaLabel={intl.formatMessage({ id: "statistics.range" })} value={location.range} onChange={(range) => update({ range: range as StatisticsLocation["range"] })}
					options={(["today", "7d", "30d", "all", "custom"] as const).map((range) => ({ value: range, label: intl.formatMessage({ id: `statistics.range.${range}` }) }))} /></div>
				{location.range === "custom" && <><label className="stats-filter"><span>{intl.formatMessage({ id: "statistics.from" })}</span><input type="date" min="1970-01-01" max="2100-12-31" value={location.start} onChange={(event) => update({ start: event.target.value })} /></label><label className="stats-filter"><span>{intl.formatMessage({ id: "statistics.to" })}</span><input type="date" min="1970-01-01" max="2100-12-31" value={location.end} onChange={(event) => update({ end: event.target.value })} /></label></>}
				<div className="stats-filter"><span>{intl.formatMessage({ id: "statistics.workspace" })}</span><CustomSelect compact ariaLabel={intl.formatMessage({ id: "statistics.workspace" })} value={location.workspaceId} onChange={(workspaceId) => update({ workspaceId })} options={[
					{ value: "", label: intl.formatMessage({ id: "statistics.allWorkspaces" }) },
					...(location.workspaceId && !options.data?.workspaces.some((row) => row.id === location.workspaceId) ? [{ value: location.workspaceId, label: location.workspaceId }] : []),
					...(options.data?.workspaces.map((row) => ({ value: row.id, label: row.name })) ?? []),
				]} /></div>
				<StatisticsModelFilters location={location} models={options.data?.models ?? []} update={update} />
				<span className="stats-timezone">{intl.formatMessage({ id: "statistics.timeZone" }, { zone: location.timeZone })}</span>
			</div>
			{Boolean(options.error) && <StatisticsError compact retry={retry} />}
			<div role="tabpanel" id={`stats-panel-${location.tab}`} aria-labelledby={`stats-tab-${location.tab}`} className="stats-tab-content">
				{query === null ? <p className="stats-error" role="alert">{intl.formatMessage({ id: "statistics.invalidDates" })}</p>
					: location.tab === "overview" ? <StatisticsOverviewTab {...shared} years={years} timeZone={location.timeZone} onYear={(year) => update({ year })} />
					: location.tab === "models" ? <StatisticsModelsTab {...shared} location={location} update={update} />
					: location.tab === "calls" ? <StatisticsCallsTab {...shared} location={location} update={update} />
					: location.tab === "runs" ? <StatisticsRunsTab {...shared} location={location} update={update} />
					: <StatisticsWorkspacesTab {...shared} location={location} update={update} />}
			</div>
			<p className="stats-scope">{intl.formatMessage({ id: "statistics.scope" })}</p>
		</div></div>
	</>;
}
