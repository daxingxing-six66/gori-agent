"use client";

import { useRef, useState } from "react";
import { useIntl } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import type { StatisticsOverview } from "../model/statistics";
import { localDay } from "../model/statistics-location";
import { useStatisticsFormat } from "./statistics-shared";
import { StatisticsTooltip, useStatisticsTooltip } from "./statistics-tooltip";

export function StatisticsCalendar({ calendar, generatedAt, timeZone, years, onYear }: {
	calendar: StatisticsOverview["calendar"]; generatedAt: number; timeZone: string; years: number[]; onYear(year: number): void;
}) {
	const intl = useIntl();
	const format = useStatisticsFormat();
	const [metric, setMetric] = useState<"tokens" | "runs">("tokens");
	const [selected, setSelected] = useState<number | null>(null);
	const tooltip = useStatisticsTooltip();
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const leading = new Date(`${calendar.year}-01-01T12:00:00Z`).getUTCDay();
	const columns = Math.ceil((leading + calendar.days.length) / 7);
	const today = localDay(generatedAt, timeZone);
	const value = (day: typeof calendar.days[number]) => metric === "tokens" ? day.usage.totalTokens : day.runs;
	const maximum = Math.max(1, ...calendar.days.map(value));
	const level = (amount: number) => amount === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(amount / maximum) * 4)));
	const detail = (index: number) => {
		const day = calendar.days[index];
		return `${intl.formatMessage({ id: "statistics.activityDetail" }, { date: day.date, tokens: format.exact(day.usage.totalTokens), runs: format.exact(day.runs) })} · ${intl.formatMessage({ id: day.active ? "statistics.active" : "statistics.inactive" })}`;
	};
	const lastAvailable = Math.max(0, calendar.days.findLastIndex((day) => day.date <= today));
	const selectedDay = selected === null ? null : calendar.days[selected];
	const hasDetails = (day: typeof calendar.days[number]) => day.date <= today && (day.usage.totalTokens > 0 || day.runs > 0);
	return <section className="stats-section stats-calendar">
		<div className="stats-section-heading"><div><h3>{intl.formatMessage({ id: "statistics.activity" })}</h3><p>{intl.formatMessage({ id: "statistics.activityHint" }, { year: String(calendar.year) })}</p></div>
			<div className="stats-chart-controls"><div className="stats-segmented" role="group" aria-label={intl.formatMessage({ id: "statistics.activity" })}>
				{(["tokens", "runs"] as const).map((key) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => { setMetric(key); tooltip.hide(); }}>{intl.formatMessage({ id: `statistics.trend.${key}` })}</button>)}
			</div><div className="stats-select-compact"><CustomSelect compact ariaLabel={intl.formatMessage({ id: "statistics.year" })} value={String(calendar.year)} onChange={(value) => onYear(Number(value))}
				options={years.map((year) => ({ value: String(year), label: String(year) }))} /></div></div>
		</div>
		<div className="stats-calendar-summary">{([
			["statistics.activeDays", format.exact(calendar.activeDays)],
			["statistics.currentStreak", intl.formatMessage({ id: "statistics.days" }, { count: calendar.currentStreak })],
			["statistics.longestStreak", intl.formatMessage({ id: "statistics.days" }, { count: calendar.longestStreak })],
			["statistics.peakTokens", format.compact(calendar.peakTokens)],
		] as const).map(([id, text]) => <div key={id}><strong>{text}</strong><span>{intl.formatMessage({ id })}</span></div>)}</div>
		<div className="stats-calendar-scroll app-scrollbar"><div className="stats-calendar-inner">
			<div className="stats-months" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>{Array.from({ length: 12 }, (_, month) => {
				const day = new Date(Date.UTC(calendar.year, month, 1, 12));
				const offset = Math.round((day.getTime() - Date.UTC(calendar.year, 0, 1, 12)) / 86400_000);
				return <span key={month} style={{ gridColumn: Math.floor((offset + leading) / 7) + 1 }}>{intl.formatDate(day, { month: "short", timeZone: "UTC" })}</span>;
			})}</div>
			<div className="stats-calendar-body"><div className="stats-weekdays">{[0, 1, 2, 3, 4, 5, 6].map((day) => <span key={day}>{day % 2 === 1 ? intl.formatDate(Date.UTC(2026, 9, 11 + day), { weekday: "short", timeZone: "UTC" }) : ""}</span>)}</div>
				<div className="stats-calendar-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }} role="group" aria-label={intl.formatMessage({ id: "statistics.activity" })}>
					{Array.from({ length: leading }, (_, index) => <span key={`padding-${index}`} />)}
					{calendar.days.map((day, index) => <button type="button" key={day.date} ref={(element) => { buttons.current[index] = element; }}
						className="stats-calendar-day" data-level={level(value(day))} data-future={day.date > today}
						aria-label={detail(index)} aria-describedby={selected === index && hasDetails(day) && tooltip.anchor ? tooltip.id : undefined} disabled={day.date > today}
						tabIndex={selected === index || (selected === null && index === lastAvailable) ? 0 : -1}
						onPointerEnter={(event) => { setSelected(index); if (hasDetails(day)) tooltip.follow(event); else tooltip.hide(); }} onPointerMove={(event) => { if (hasDetails(day)) tooltip.follow(event); }} onPointerLeave={tooltip.hide}
						onFocus={(event) => { setSelected(index); if (hasDetails(day)) tooltip.focus(event.currentTarget); else tooltip.hide(); }} onBlur={tooltip.hide} onClick={(event) => { setSelected(index); if (hasDetails(day)) tooltip.focus(event.currentTarget); else tooltip.hide(); }}
						onKeyDown={(event) => {
							const delta = event.key === "ArrowRight" ? 7 : event.key === "ArrowLeft" ? -7 : event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : null;
							const next = event.key === "Home" ? 0 : event.key === "End" ? lastAvailable : delta === null ? null : Math.max(0, Math.min(lastAvailable, index + delta));
							if (next !== null) { event.preventDefault(); setSelected(next); buttons.current[next]?.focus(); }
						}} />)}
				</div>
			</div>
		</div></div>
		<div className="stats-calendar-footer"><span className="sr-only" aria-live="polite">{selected !== null && selectedDay ? detail(selected) : ""}</span>
			<div className="stats-intensity-legend"><span>{intl.formatMessage({ id: "statistics.less" })}</span>{[0, 1, 2, 3, 4].map((value) => <i key={value} data-level={value} />)}<span>{intl.formatMessage({ id: "statistics.more" })}</span></div>
		</div>
		{selectedDay && hasDetails(selectedDay) && tooltip.anchor && <StatisticsTooltip key={selectedDay.date} id={tooltip.id} anchor={tooltip.anchor} title={selectedDay.date}>
			<dl className="stats-tooltip-values"><div><dt>{intl.formatMessage({ id: "statistics.tokens" })}</dt><dd>{format.exact(selectedDay.usage.totalTokens)}</dd></div>
				<div><dt>{intl.formatMessage({ id: "statistics.runs" })}</dt><dd>{format.exact(selectedDay.runs)}</dd></div></dl>
			<p className="stats-tooltip-status">{intl.formatMessage({ id: selectedDay.active ? "statistics.active" : "statistics.inactive" })}</p>
		</StatisticsTooltip>}
	</section>;
}
