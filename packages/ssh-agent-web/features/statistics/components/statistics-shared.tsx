"use client";

import { ArrowDown, ArrowUp, BarChart3, Info, RotateCw } from "lucide-react";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";
import type { MessageId } from "@/features/i18n/messages/zh-CN";
import type { StatisticsUsage } from "../model/statistics";

export function useStatisticsFormat() {
	const intl = useIntl();
	const exact = (value: number) => intl.formatNumber(value, { maximumFractionDigits: 0 });
	const compact = (value: number) => intl.formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
	const money = (value: number) => `${value > 0 && value < 0.000001 ? "<" : ""}${intl.formatNumber(value > 0 && value < 0.000001 ? 0.000001 : value,
		{ style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value >= .01 ? 4 : 6 })}`;
	const duration = (value: number | null) => {
		if (value === null) return "—";
		const unit = value >= 3600_000 ? "hour" : value >= 60_000 ? "minute" : "second";
		return intl.formatNumber(value / (unit === "hour" ? 3600_000 : unit === "minute" ? 60_000 : 1000),
			{ style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 });
	};
	const cost = (usage: StatisticsUsage) => usage.calls > 0 && usage.costSamples === 0 ? "—" : money(usage.cost.total);
	const tokens = (usage: StatisticsUsage) => usage.calls > 0 && usage.usageSamples === 0 ? "—" : compact(usage.totalTokens);
	return { exact, compact, money, duration, cost, tokens };
}

export function StatisticsLoading() {
	const intl = useIntl();
	return <div className="stats-loading" role="status" aria-label={intl.formatMessage({ id: "statistics.loading" })}>
		<div className="stats-skeleton-cards">{[0, 1, 2, 3].map((key) => <div key={key} />)}</div>
		<div className="stats-skeleton-chart" /><span className="sr-only">{intl.formatMessage({ id: "statistics.loading" })}</span>
	</div>;
}

export function StatisticsError({ retry, compact = false }: { retry(): void; compact?: boolean }) {
	const intl = useIntl();
	return <div className={`stats-error${compact ? " stats-error-compact" : ""}`} role="alert">
		<p>{intl.formatMessage({ id: compact ? "statistics.optionsError" : "statistics.error" })}</p>
		<button type="button" className="page-button" onClick={retry}><RotateCw size={13} />{intl.formatMessage({ id: "statistics.retry" })}</button>
	</div>;
}

export function StatisticsEmpty({ small = false }: { small?: boolean }) {
	const intl = useIntl();
	return <div className={`stats-empty${small ? " stats-empty-small" : ""}`}>
		<BarChart3 size={25} strokeWidth={1.3} aria-hidden="true" />
		<h3>{intl.formatMessage({ id: small ? "statistics.noRows" : "statistics.empty" })}</h3>
		{!small && <p>{intl.formatMessage({ id: "statistics.emptyHint" })}</p>}
	</div>;
}

export function StatisticsUpdated({ timestamp, timeZone }: { timestamp: number; timeZone: string }) {
	const intl = useIntl();
	return <p className="stats-updated">{intl.formatMessage({ id: "statistics.updated" }, {
		time: intl.formatTime(timestamp, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone }),
	})}</p>;
}

type Coverage = Pick<StatisticsUsage, "calls" | "usageSamples" | "costSamples">;

export function statisticsCoverage(rows: { usage: Coverage }[]): Coverage {
	return rows.reduce((total, row) => ({ calls: total.calls + row.usage.calls,
		usageSamples: total.usageSamples + row.usage.usageSamples, costSamples: total.costSamples + row.usage.costSamples }),
		{ calls: 0, usageSamples: 0, costSamples: 0 });
}

export function UsageCoverage({ usage }: { usage: Coverage }) {
	const intl = useIntl();
	const missingUsage = usage.calls - usage.usageSamples, missingCost = usage.calls - usage.costSamples;
	if (!missingUsage && !missingCost) return null;
	return <div className="stats-coverage"><Info size={13} aria-hidden="true" /><div>
		{missingUsage > 0 && <p>{intl.formatMessage({ id: "statistics.missingUsage" }, { count: missingUsage })}</p>}
		{missingCost > 0 && <p>{intl.formatMessage({ id: "statistics.missingCost" }, { count: missingCost })}</p>}
	</div></div>;
}

export function UsageBreakdown({ usage, costs = false }: { usage: StatisticsUsage; costs?: boolean }) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	return <dl className="stats-breakdown">{(["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => <div key={key}>
		<dt><i className={`stats-dot stats-series-${key}`} />{intl.formatMessage({ id: `statistics.${key}` })}</dt>
		<dd>{costs ? (usage.costSamples ? format.money(usage.cost[key]) : "—") : (usage.usageSamples ? format.exact(usage[key]) : "—")}</dd>
	</div>)}</dl>;
}

export function StatisticsMetric({ label, value, detail, icon }: { label: string; value: string; detail?: ReactNode; icon?: ReactNode }) {
	return <div className="stats-metric"><div className="stats-metric-label">{label}{icon}</div>
		<div className="stats-metric-value">{value}</div>{detail && <div className="stats-metric-detail">{detail}</div>}
	</div>;
}

export function SortHeading({ labelId, sortKey, activeSort, direction, onSort }: {
	labelId: MessageId; sortKey: string; activeSort: string; direction: string; onSort(key: string): void;
}) {
	const intl = useIntl();
	const label = intl.formatMessage({ id: labelId });
	return <th scope="col" className="stats-number" aria-sort={activeSort === sortKey ? direction === "asc" ? "ascending" : "descending" : "none"}>
		<button type="button" onClick={() => onSort(sortKey)} aria-label={intl.formatMessage({ id: "statistics.sort" }, { column: label })}>
			{label}{activeSort === sortKey && (direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
		</button>
	</th>;
}
