"use client";

import { useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import type { StatisticsDay } from "../model/statistics";
import { shiftDay } from "../model/statistics-location";
import { useStatisticsFormat } from "./statistics-shared";
import { StatisticsTooltip, useStatisticsTooltip } from "./statistics-tooltip";

type Metric = "tokens" | "cost" | "runs";
const series = ["input", "cacheRead", "cacheWrite", "output"] as const;
type Series = typeof series[number];

export function groupTrendDays(days: StatisticsDay[], weekly: boolean): StatisticsDay[] {
	if (!weekly) return days;
	const groups = new Map<string, StatisticsDay>();
	for (const day of days) {
		const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
		const key = shiftDay(day.date, -(weekday + 6) % 7);
		const current = groups.get(key);
		if (!current) groups.set(key, { ...day, date: key, usage: { ...day.usage, cost: { ...day.usage.cost } } });
		else {
			current.runs += day.runs; current.active ||= day.active;
			for (const field of ["calls", "usageSamples", "costSamples", "input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) current.usage[field] += day.usage[field];
			for (const field of [...series, "total"] as const) current.usage.cost[field] += day.usage.cost[field];
		}
	}
	return [...groups.values()];
}

export function StatisticsTrend({ days }: { days: StatisticsDay[] }) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	const [metric, setMetric] = useState<Metric>("tokens");
	const [weekly, setWeekly] = useState(days.length > 90);
	const [hidden, setHidden] = useState<Series[]>([]);
	const [selected, setSelected] = useState<number | null>(null);
	const [hovered, setHovered] = useState<number | null>(null);
	const tooltip = useStatisticsTooltip();
	const leaveBar = () => { setHovered(null); tooltip.hide(); };
	const barsRef = useRef<(SVGGElement | null)[]>([]);
	const points = useMemo(() => groupTrendDays(days, weekly), [days, weekly]);
	const values = (day: StatisticsDay) => metric === "tokens" ? series.map((key) => hidden.includes(key) ? 0 : day.usage[key])
		: [metric === "cost" ? day.usage.cost.total : day.runs];
	const max = Math.max(1, ...points.map((day) => values(day).reduce((sum, value) => sum + value, 0)));
	const width = Math.max(680, points.length * 9), height = 190, plotLeft = 58, plotRight = width - 12;
	const step = (plotRight - plotLeft) / Math.max(1, points.length);
	const hoveredDay = hovered === null ? null : points[hovered];
	const display = (value: number) => metric === "cost" ? format.money(value) : format.compact(value);
	return <section className="stats-section stats-trend">
		<div className="stats-section-heading"><div><h3>{intl.formatMessage({ id: "statistics.trend" })}</h3><p>{intl.formatMessage({ id: "statistics.trendHint" })}</p></div>
			<div className="stats-chart-controls"><div className="stats-segmented" role="group" aria-label={intl.formatMessage({ id: "statistics.trend" })}>
				{(["tokens", "cost", "runs"] as const).map((key) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => { setMetric(key); setSelected(null); leaveBar(); }}>{intl.formatMessage({ id: `statistics.trend.${key}` })}</button>)}
			</div><div className="stats-select-compact"><CustomSelect compact ariaLabel={intl.formatMessage({ id: "statistics.daily" })} value={weekly ? "week" : "day"} onChange={(value) => { setWeekly(value === "week"); setSelected(null); leaveBar(); }}
				options={[{ value: "day", label: intl.formatMessage({ id: "statistics.daily" }) }, { value: "week", label: intl.formatMessage({ id: "statistics.weekly" }) }]} /></div></div>
		</div>
		<div className="stats-chart-scroll app-scrollbar">
			<svg viewBox={`0 0 ${width} 245`} style={{ minWidth: width }} role="group" aria-label={intl.formatMessage({ id: "statistics.trend" })}>
				{[0, .25, .5, .75, 1].map((fraction) => <g key={fraction}><line className="stats-chart-grid" x1={plotLeft} x2={plotRight} y1={height - fraction * 165} y2={height - fraction * 165} /><text className="stats-chart-label" x={plotLeft - 12} y={height - fraction * 165 + 4} textAnchor="end">{display(max * fraction)}</text></g>)}
				{points.map((day, index) => {
					const bars = values(day);
					let offset = 0;
					const total = bars.reduce((sum, value) => sum + value, 0);
					const label = `${day.date} · ${metric === "cost" ? format.money(total) : format.exact(total)}`;
					return <g key={day.date}>
						<g ref={(element) => { barsRef.current[index] = element; }} tabIndex={selected === index || (selected === null && index === 0) ? 0 : -1} role="img" aria-label={label}
							aria-describedby={hovered === index && tooltip.anchor ? tooltip.id : undefined}
							onPointerEnter={(event) => { setHovered(index); tooltip.follow(event); }} onPointerMove={tooltip.follow} onPointerLeave={leaveBar}
							onFocus={() => setSelected(index)} onKeyDown={(event) => {
								const next = event.key === "ArrowRight" ? Math.min(points.length - 1, index + 1) : event.key === "ArrowLeft" ? Math.max(0, index - 1) : event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : null;
								if (next !== null) { event.preventDefault(); setSelected(next); barsRef.current[next]?.focus(); }
							}}>
							<rect className="stats-chart-hit" x={plotLeft + index * step} y="20" width={step} height="172" />
							{bars.map((value, segment) => {
								const barHeight = value / max * 165;
								const y = height - offset - barHeight; offset += barHeight;
								return <rect key={segment} className={`stats-bar ${metric === "tokens" ? `stats-series-${series[segment]}` : "stats-series-input"}`}
									x={plotLeft + index * step + Math.max(1, step * .16)} y={y} width={Math.max(1, step * .68)} height={barHeight} rx={1} />;
							})}
						</g>
						{(index === 0 || index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 7)) === 0) && <text className="stats-chart-label" x={plotLeft + (index + .5) * step} y="218" textAnchor="middle">{intl.formatDate(`${day.date}T12:00:00Z`, { month: "short", day: "numeric", timeZone: "UTC" })}</text>}
					</g>;
				})}
			</svg>
		</div>
		{metric === "tokens" && <div className="stats-chart-footer">
			<div className="stats-legend">{series.map((key) => <button type="button" key={key} aria-pressed={!hidden.includes(key)} onClick={() => setHidden((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key])}><i className={`stats-dot stats-series-${key}`} />{intl.formatMessage({ id: `statistics.${key}` })}</button>)}</div>
		</div>}
		{hoveredDay && tooltip.anchor && <StatisticsTooltip key={hoveredDay.date} id={tooltip.id} anchor={tooltip.anchor} title={hoveredDay.date}>
			<dl className="stats-tooltip-values"><div className="stats-tooltip-total"><dt>{intl.formatMessage({ id: metric === "tokens" ? "statistics.tokens" : metric === "cost" ? "statistics.cost" : "statistics.runs" })}</dt>
				<dd>{metric === "cost" ? format.money(hoveredDay.usage.cost.total) : format.exact(values(hoveredDay).reduce((sum, value) => sum + value, 0))}</dd></div>
				{metric === "tokens" && series.filter((key) => !hidden.includes(key)).map((key) => <div key={key}><dt><i className={`stats-dot stats-series-${key}`} />{intl.formatMessage({ id: `statistics.${key}` })}</dt><dd>{format.exact(hoveredDay.usage[key])}</dd></div>)}
			</dl>
		</StatisticsTooltip>}
	</section>;
}
