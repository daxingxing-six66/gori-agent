"use client";

import { Activity, ArrowUpRight, Coins, Layers3 } from "lucide-react";
import { useIntl } from "react-intl";
import { useStatistics } from "../runtime/use-statistics";
import { StatisticsCalendar } from "./statistics-calendar";
import { StatisticsTrend } from "./statistics-trend";
import { StatisticsEmpty, StatisticsError, StatisticsLoading, StatisticsMetric, StatisticsUpdated, UsageBreakdown, UsageCoverage, useStatisticsFormat } from "./statistics-shared";

export function StatisticsOverviewTab({ query, refresh, retry, years, timeZone, onYear }: {
	query: string; refresh: number; retry(): void; years: number[]; timeZone: string; onYear(year: number): void;
}) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	const state = useStatistics("overview", query, refresh);
	if (state.loading) return <StatisticsLoading />;
	if (state.error || !state.data) return <StatisticsError retry={retry} />;
	const data = state.data;
	const runCounts = intl.formatMessage({ id: "statistics.runCounts" }, { completed: data.runs.completed, failed: data.runs.failed, cancelled: data.runs.cancelled });
	return <div className="stats-overview">
		<div className="stats-metrics">
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.tokens" })} value={format.tokens(data.usage)} icon={<Layers3 size={16} />}
				detail={<details className="stats-metric-popover"><summary>{data.usage.calls > 0 && data.usage.usageSamples === 0 ? intl.formatMessage({ id: "statistics.unknown" }) : <>{intl.formatMessage({ id: "statistics.input" })} {format.compact(data.usage.input)} <span>·</span> {intl.formatMessage({ id: "statistics.output" })} {format.compact(data.usage.output)}</>}</summary><UsageBreakdown usage={data.usage} /></details>} />
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.cost" })} value={format.cost(data.usage)} icon={<Coins size={16} />}
				detail={<details className="stats-metric-popover"><summary>{intl.formatMessage({ id: "statistics.costHint" })}</summary><UsageBreakdown usage={data.usage} costs /></details>} />
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.calls" })} value={format.compact(data.usage.calls)} icon={<ArrowUpRight size={16} />}
				detail={intl.formatMessage({ id: "statistics.callsHint" })} />
			<StatisticsMetric label={intl.formatMessage({ id: "statistics.runs" })} value={format.compact(data.runs.total)} icon={<Activity size={16} />} detail={runCounts} />
		</div>
		<UsageCoverage usage={data.usage} />
		{data.usage.calls === 0 && data.runs.total === 0 ? <StatisticsEmpty /> : <StatisticsTrend key={`${data.range.from}-${data.range.to}`} days={data.trend} />}
		<StatisticsCalendar key={data.calendar.year} calendar={data.calendar} generatedAt={data.generatedAt} timeZone={timeZone} years={years} onYear={onYear} />
		<StatisticsUpdated timestamp={data.generatedAt} timeZone={timeZone} />
	</div>;
}
